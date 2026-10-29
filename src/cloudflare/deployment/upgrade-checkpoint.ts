import { CloudflareApiError, type CloudflareApiClient } from '../cloudflare-api';
import type { DeploymentFence } from './fence';
import { UPGRADE_BACKUP_PREFIX, SHARED_SETTINGS_KEY } from '../../protocol/storage-keys';
import { sha256Hex } from '../../platform/sha256';

const CONTROL = new Set(['maintenance_state', 'crate_schema', 'crate_migrations', 'crate_release']);
const quoteName = (name: string) => `"${name.replace(/"/g, '""')}"`;
const quoteValue = (value: unknown): string => value === null ? 'NULL' : typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : (() => { throw new Error('Unsupported database value in upgrade checkpoint'); })();
export function upgradeGuards(table: string): string {
	if (CONTROL.has(table)) return '';
	return ['INSERT', 'UPDATE', 'DELETE'].map(action => `CREATE TRIGGER IF NOT EXISTS ${quoteName(`crate_upgrade_${table}_${action}`)} BEFORE ${action} ON ${quoteName(table)} BEGIN SELECT RAISE(ABORT, 'Crate server upgrade in progress'); END;`).join('\n');
}
const PAGE_ROWS = 500;
const ROWID = 'crate_upgrade_rowid';
type Query = (sql: string) => Promise<Array<Record<string, unknown>>>;

/** Keyset paging reads each row once, unlike OFFSET paging. Ordinary tables page
 * by rowid; WITHOUT ROWID tables page by their primary key. Both are scan order. */
async function pageKey(rows: Query, table: string, definition: string): Promise<string[] | null> {
	if (!/\bWITHOUT\s+ROWID\b/i.test(definition)) return null;
	const key = (await rows(`PRAGMA table_info(${quoteName(table)});`)).filter(row => Number(row.pk) > 0)
		.sort((a, b) => Number(a.pk) - Number(b.pk)).map(row => String(row.name));
	if (!key.length) throw new Error('Cannot back up an unrecognized server table');
	return key;
}
function pageSql(table: string, key: string[] | null, after: unknown[] | null): string {
	if (!key) return `SELECT rowid AS ${ROWID}, * FROM ${quoteName(table)}${after ? ` WHERE rowid > ${quoteValue(after[0])}` : ''} ORDER BY rowid LIMIT ${PAGE_ROWS};`;
	const columns = key.map(quoteName).join(',');
	return `SELECT * FROM ${quoteName(table)}${after ? ` WHERE (${columns}) > (${after.map(quoteValue).join(',')})` : ''} ORDER BY ${columns} LIMIT ${PAGE_ROWS};`;
}
/** Splits a keyset page row into its key and the stored columns. */
function pageRow(row: Record<string, unknown>, key: string[] | null): { after: unknown[]; record: Record<string, unknown> } {
	if (key) return { after: key.map(column => row[column]), record: row };
	const { [ROWID]: rowid, ...record } = row;
	return { after: [rowid], record };
}

export function removeUpgradeGuards(table: string): string {
	return ['INSERT', 'UPDATE', 'DELETE'].map(action => `DROP TRIGGER IF EXISTS ${quoteName(`crate_upgrade_${table}_${action}`)};`).join('\n');
}

/** The old Worker need not understand Reading: database triggers fence its mutations too. */
export async function createUpgradeCheckpoint(input: { api: CloudflareApiClient; accountId: string; databaseId: string; bucketName: string; fence: DeploymentFence; onProgress?: (message: string) => void }): Promise<void> {
	const { api, accountId, databaseId, bucketName, fence } = input;
	const rows = async (sql: string) => (await api.queryD1(accountId, databaseId, sql)).flatMap(result => result.results ?? []);
	const definitions = await rows("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type DESC, name;");
	const tables = definitions.filter(row => row.type === 'table').map(row => String(row.name));
	if (!tables.includes('files') || !tables.includes('crate_schema')) throw new Error('Cannot back up an unrecognized server database');
	fence.requireVerification();
	await fence.mutate(() => api.queryD1(accountId, databaseId, tables.map(upgradeGuards).join('\n')), 'freeze-upgrade-data');
	const prefix = `${UPGRADE_BACKUP_PREFIX}${crypto.randomUUID()}`;
	input.onProgress?.('Backing up the server database. Large servers can take several minutes…');
	let sql = 'PRAGMA foreign_keys=OFF;\n';
	for (const row of definitions.filter(row => row.type === 'table')) {
		const table = String(row.name); sql += `${String(row.sql)};\n`;
		const key = await pageKey(rows, table, String(row.sql));
		for (let after: unknown[] | null = null;;) {
			const page = await rows(pageSql(table, key, after));
			for (const item of page) {
				const { after: next, record } = pageRow(item, key);
				sql += `INSERT INTO ${quoteName(table)} (${Object.keys(record).map(quoteName).join(',')}) VALUES (${Object.values(record).map(quoteValue).join(',')});\n`;
				after = next;
			}
			if (page.length < PAGE_ROWS) break;
			if (sql.length > 128 * 1024 * 1024) throw new Error('Database checkpoint exceeds the in-app backup limit. Use Crate recovery tools before upgrading.');
		}
	}
	sql += definitions.filter(row => row.type === 'index').map(row => `${String(row.sql)};`).join('\n');
	// Preserve an AUTOINCREMENT cursor even when all older changelog rows were pruned.
	const sequences = await rows('SELECT name, seq FROM sqlite_sequence;');
	sql += '\nDELETE FROM sqlite_sequence;\n' + sequences.map(row => `INSERT INTO sqlite_sequence(name,seq) VALUES (${quoteValue(row.name)},${quoteValue(row.seq)});`).join('\n');
	const databaseSha256 = await sha256Hex(sql);
	await api.putRecoveryObject(accountId, bucketName, `${prefix}/database.sql`, new TextEncoder().encode(sql));
	const verifiedSql = await api.getRecoveryObject(accountId, bucketName, `${prefix}/database.sql`);
	if (await sha256Hex(verifiedSql) !== databaseSha256) throw new Error('Database checkpoint verification failed');
	const objects: Array<{ key: string; sha256: string; size: number; contentType: string }> = [];
	input.onProgress?.('Counting files and history for the backup…');
	const refs = await rows('SELECT storage_key, hash, size FROM files UNION SELECT storage_key, hash, size FROM file_versions;');
	const uniqueRefs = new Map<string, (typeof refs)[number]>();
	for (const row of refs) {
		const key = String(row.storage_key);
		const previous = uniqueRefs.get(key);
		if (previous) {
			if (`${String(previous.hash)}:${String(previous.size)}` !== `${String(row.hash)}:${String(row.size)}`) throw new Error('Conflicting file references in checkpoint');
			continue;
		}
		uniqueRefs.set(key, row);
	}
	const total = uniqueRefs.size;
	let lastReportedAt = 0;
	const reportFiles = (verified: number) => {
		const now = Date.now();
		// The dialog announces status changes to screen readers; avoid announcing every file in a large vault.
		if (verified > 0 && verified < total && now - lastReportedAt < 5_000) return;
		lastReportedAt = now;
		input.onProgress?.(`Backing up files and history: ${verified.toLocaleString()} of ${total.toLocaleString()} verified. This may take several minutes…`);
	};
	if (total) reportFiles(0);
	for (const [key, row] of uniqueRefs) {
		const bytes = await api.getRecoveryObject(accountId, bucketName, key);
		if (bytes.byteLength !== row.size || await sha256Hex(bytes) !== row.hash) throw new Error('A server file could not be verified. Upgrade has not started.');
		const backupKey = `${prefix}/objects/${await sha256Hex(key)}`;
		await api.putRecoveryObject(accountId, bucketName, backupKey, bytes);
		if (await sha256Hex(await api.getRecoveryObject(accountId, bucketName, backupKey)) !== row.hash) throw new Error('File checkpoint verification failed');
		objects.push({ key, sha256: String(row.hash), size: bytes.byteLength, contentType: 'application/octet-stream' });
		reportFiles(objects.length);
	}
	input.onProgress?.('Finishing and verifying the backup archive…');
	try {
		const key = SHARED_SETTINGS_KEY, bytes = await api.getRecoveryObject(accountId, bucketName, key);
		const sha = await sha256Hex(bytes), backupKey = `${prefix}/objects/${await sha256Hex(key)}`;
		await api.putRecoveryObject(accountId, bucketName, backupKey, bytes);
		if (await sha256Hex(await api.getRecoveryObject(accountId, bucketName, backupKey)) !== sha) throw new Error('Settings checkpoint verification failed');
		objects.push({ key, sha256: sha, size: bytes.byteLength, contentType: 'application/json' });
	} catch (error) { if (!(error instanceof CloudflareApiError && error.status === 404)) throw error; }
	const manifest = JSON.stringify({ format: 1, complete: true, createdAt: new Date().toISOString(), source: { account: accountId, database: databaseId, bucket: bucketName }, bookmark: null, databaseSha256, objects });
	await api.putRecoveryObject(accountId, bucketName, `${prefix}/archive.json`, new TextEncoder().encode(manifest));
	if (await sha256Hex(await api.getRecoveryObject(accountId, bucketName, `${prefix}/archive.json`)) !== await sha256Hex(manifest)) throw new Error('Checkpoint manifest verification failed');
	await fence.mutate(() => api.queryD1(accountId, databaseId, "INSERT OR REPLACE INTO maintenance_state(key,value) VALUES ('crate_upgrade_checkpoint', ?);", [prefix]), 'verify-upgrade-checkpoint');
}
export async function releaseUpgradeGuards(api: Pick<CloudflareApiClient, 'queryD1'>, account: string, database: string, fence: DeploymentFence) {
	const rows = (await api.queryD1(account, database, "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'crate_upgrade_%';")).flatMap(result => result.results ?? []);
	if (rows.length) await fence.mutate(() => api.queryD1(account, database, rows.map(row => `DROP TRIGGER ${quoteName(String(row.name))};`).join('\n')), 'resume-upgraded-server');
}
