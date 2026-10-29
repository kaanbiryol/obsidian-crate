import { CloudflareApiError, type CloudflareApiClient } from '../cloudflare-api';
import type { DeploymentFence } from './fence';
import { UPGRADE_BACKUP_PREFIX, UPGRADE_BACKUP_STORE, SHARED_SETTINGS_KEY, upgradeBackupStoreKey } from '../../protocol/storage-keys';
import { sha256Hex } from '../../platform/sha256';
import { isSha256Hex } from '../../platform/validation';
import { listBackupObjects, pruneUpgradeBackups } from './upgrade-backups';

const CONTROL = new Set(['maintenance_state', 'crate_schema', 'crate_migrations', 'crate_release']);
const quoteName = (name: string) => `"${name.replace(/"/g, '""')}"`;
const quoteValue = (value: unknown): string => value === null ? 'NULL' : typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : (() => { throw new Error('Unsupported database value in upgrade checkpoint'); })();
const GUARDED_ACTIONS = ['INSERT', 'UPDATE', 'DELETE'];
export function upgradeGuards(table: string): string {
	if (CONTROL.has(table)) return '';
	return GUARDED_ACTIONS.map(action => `CREATE TRIGGER IF NOT EXISTS ${quoteName(`crate_upgrade_${table}_${action}`)} BEFORE ${action} ON ${quoteName(table)} BEGIN SELECT RAISE(ABORT, 'Crate server upgrade in progress'); END;`).join('\n');
}
const PAGE_ROWS = 500;
const ROWID = 'crate_upgrade_rowid';
type Query = (sql: string, params?: string[]) => Promise<Array<Record<string, unknown>>>;
type PageRow = { after: unknown[]; record: Record<string, unknown> };

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
function pageRow(row: Record<string, unknown>, key: string[] | null): PageRow {
	if (key) return { after: key.map(column => row[column]), record: row };
	const { [ROWID]: rowid, ...record } = row;
	return { after: [rowid], record };
}
async function* tablePages(rows: Query, table: string, definition: string, start: unknown[] | null = null): AsyncGenerator<PageRow[]> {
	const key = await pageKey(rows, table, definition);
	for (let after = start; ;) {
		const page = (await rows(pageSql(table, key, after))).map(row => pageRow(row, key));
		yield page;
		if (page.length < PAGE_ROWS) return;
		after = page[page.length - 1]!.after;
	}
}

export function removeUpgradeGuards(table: string): string {
	return GUARDED_ACTIONS.map(action => `DROP TRIGGER IF EXISTS ${quoteName(`crate_upgrade_${table}_${action}`)};`).join('\n');
}

/** Saved in D1 so an interrupted backup resumes on any device instead of restarting. */
const PROGRESS_KEY = 'crate_upgrade_backup';
// Database parts end at statement boundaries, so each part stays a few megabytes.
const PART_CHARACTERS = 4 * 1024 * 1024;
const BACKUP_PREFIX = /^__crate__\/backups\/schema-upgrade-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
interface BackupPart { sha256: string; size: number }
interface FileReference { key: string; sha256: string; size: number }
/** `copying` runs while sync continues. `dumping` and `finishing` stay valid only
 * while every write guard has existed since the dump started. */
interface CopyingProgress { format: 2; phase: 'copying'; prefix: string }
/** `table` and `after` name the next row to export; earlier rows are saved in `parts`. */
interface DumpingProgress { format: 2; phase: 'dumping'; prefix: string; createdAt: string; parts: BackupPart[]; table: number; after: unknown[] | null }
interface ExportedProgress { format: 2; phase: 'finishing' | 'complete'; prefix: string; createdAt: string; parts: BackupPart[] }
type BackupProgress = CopyingProgress | DumpingProgress | ExportedProgress;
type SavedProgress = { raw: string | null; progress: BackupProgress | null };

function parseProgress(value: unknown): BackupProgress | null {
	let parsed: Record<string, unknown>;
	try { parsed = typeof value === 'string' ? JSON.parse(value) as Record<string, unknown> : {}; } catch { return null; }
	if (!parsed || parsed.format !== 2 || typeof parsed.prefix !== 'string' || !BACKUP_PREFIX.test(parsed.prefix) || parsed.prefix === UPGRADE_BACKUP_STORE) return null;
	if (parsed.phase === 'copying') return parsed as unknown as BackupProgress;
	if (!['dumping', 'finishing', 'complete'].includes(String(parsed.phase)) || typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt))
		|| !Array.isArray(parsed.parts) || parsed.parts.some((part: Partial<BackupPart> | null) => !part || !isSha256Hex(part.sha256) || !Number.isSafeInteger(part.size) || Number(part.size) < 0)) return null;
	if (parsed.phase === 'dumping' && (!Number.isSafeInteger(parsed.table) || Number(parsed.table) < 0 || (parsed.after !== null && !Array.isArray(parsed.after)))) return null;
	return parsed as unknown as BackupProgress;
}
async function readProgress(query: Query): Promise<SavedProgress> {
	const rows = await query(`SELECT value FROM maintenance_state WHERE key = '${PROGRESS_KEY}';`);
	if (!rows.length) return { raw: null, progress: null };
	const progress = parseProgress(rows[0]?.value);
	if (rows.length !== 1 || !progress) throw new Error('The saved upgrade backup progress is invalid. The update stopped before changing the database schema.');
	return { raw: String(rows[0]!.value), progress };
}
const progressChanged = () => new Error('The upgrade backup changed during this update. Check and recover the update, then try again.');
/** Compare-and-set, so a paused older attempt cannot overwrite newer progress. */
async function saveProgress(query: Query, expected: string | null, next: BackupProgress): Promise<string> {
	const value = JSON.stringify(next);
	const saved = expected === null
		? await query(`INSERT INTO maintenance_state(key, value) VALUES ('${PROGRESS_KEY}', ?) ON CONFLICT(key) DO NOTHING RETURNING value;`, [value])
		: await query(`UPDATE maintenance_state SET value = ? WHERE key = '${PROGRESS_KEY}' AND value = ? RETURNING value;`, [value, expected]);
	if (saved.length !== 1 || saved[0]?.value !== value) throw progressChanged();
	return value;
}

interface BackupContext { api: CloudflareApiClient; accountId: string; bucketName: string; query: Query; definitions: Array<Record<string, unknown>> }

async function* fileReferences(context: BackupContext): AsyncGenerator<FileReference[]> {
	for (const table of ['files', 'file_versions']) {
		const definition = context.definitions.find(row => row.type === 'table' && row.name === table);
		if (!definition) throw new Error('Cannot back up an unrecognized server database');
		for await (const page of tablePages(context.query, table, String(definition.sql))) {
			yield page.map(({ record }) => {
				const { storage_key: key, hash: sha256, size } = record;
				if (typeof key !== 'string' || !key || !isSha256Hex(sha256) || !Number.isSafeInteger(size) || Number(size) < 0) throw new Error('A server file reference is invalid. Upgrade has not started.');
				return { key, sha256, size: Number(size) };
			});
		}
	}
}

const isStored = (stored: Map<string, number | null>, sha256: string, size: number) => stored.has(sha256) && [null, size].includes(stored.get(sha256)!);

/** Stored objects are immutable and content-addressed, so backups that share a
 * file share one copy. */
async function copyToStore(context: BackupContext, file: FileReference, stored: Map<string, number | null>, required: boolean): Promise<void> {
	const { api, accountId, bucketName } = context;
	if (isStored(stored, file.sha256, file.size)) return;
	await api.throttle();
	let bytes: Uint8Array;
	try { bytes = await api.getRecoveryObject(accountId, bucketName, file.key); }
	catch (error) {
		// Writers continue while files are copied; a file removed after its reference was read is no longer needed.
		if (!required && error instanceof CloudflareApiError && error.status === 404) return;
		throw error;
	}
	if (bytes.byteLength !== file.size || await sha256Hex(bytes) !== file.sha256) throw new Error('A server file could not be verified. Upgrade has not started.');
	await api.throttle();
	await api.putRecoveryObject(accountId, bucketName, upgradeBackupStoreKey(file.sha256), bytes);
	stored.set(file.sha256, file.size);
}

/** Copies existing files before writes pause; the frozen pass then copies only newer uploads. */
async function copyFilesBeforePause(context: BackupContext, onProgress?: (message: string) => void): Promise<void> {
	const stored = await listBackupObjects(context.api, context.accountId, context.bucketName, `${UPGRADE_BACKUP_STORE}/objects/`);
	let total = Number((await context.query('SELECT (SELECT COUNT(*) FROM files) + (SELECT COUNT(*) FROM file_versions) AS total;'))[0]?.total ?? 0);
	let checked = 0, lastReportedAt = 0;
	const report = () => {
		const now = Date.now();
		// The dialog announces status changes to screen readers; avoid announcing every file in a large vault.
		if (checked > 0 && checked < total && now - lastReportedAt < 5_000) return;
		lastReportedAt = now;
		onProgress?.(`Backing up files and history: ${checked.toLocaleString()} of ${total.toLocaleString()} checked. Sync continues during this step…`);
	};
	if (total) report();
	for await (const page of fileReferences(context)) {
		for (const file of page) {
			await copyToStore(context, file, stored, false);
			checked++; total = Math.max(total, checked);
			report();
		}
	}
}

/** Exports the paused database in parts that end at statement boundaries. Their
 * concatenation is the same SQL the single-file format stored. */
async function dumpDatabase(context: BackupContext, saved: { raw: string; progress: DumpingProgress }): Promise<{ raw: string; progress: ExportedProgress }> {
	const { api, accountId, bucketName, query, definitions } = context;
	const tables = definitions.filter(row => row.type === 'table');
	let { raw, progress } = saved;
	if (progress.table > tables.length) throw new Error('The saved upgrade backup progress is invalid. The update stopped before changing the database schema.');
	let buffer = progress.parts.length ? '' : 'PRAGMA foreign_keys=OFF;\n';
	const savePart = async (): Promise<BackupPart[]> => {
		const bytes = new TextEncoder().encode(buffer);
		const sha256 = await sha256Hex(bytes);
		await api.throttle();
		await api.putRecoveryObject(accountId, bucketName, `${progress.prefix}/objects/${sha256}`, bytes);
		buffer = '';
		return [...progress.parts, { sha256, size: bytes.byteLength }];
	};
	const checkpoint = async (table: number, after: unknown[] | null) => {
		const next: DumpingProgress = { ...progress, parts: await savePart(), table, after };
		raw = await saveProgress(query, raw, next);
		progress = next;
	};
	for (let index = progress.table; index < tables.length; index++) {
		const table = String(tables[index]!.name), definition = String(tables[index]!.sql);
		const start = index === progress.table ? progress.after : null;
		// A table's definition precedes its rows, so a saved row position follows it.
		if (start === null) buffer += `${definition};\n`;
		for await (const page of tablePages(query, table, definition, start)) {
			for (const { record } of page) buffer += `INSERT INTO ${quoteName(table)} (${Object.keys(record).map(quoteName).join(',')}) VALUES (${Object.values(record).map(quoteValue).join(',')});\n`;
			if (page.length === PAGE_ROWS && buffer.length >= PART_CHARACTERS) await checkpoint(index, page[page.length - 1]!.after);
		}
		if (buffer.length >= PART_CHARACTERS) await checkpoint(index + 1, null);
	}
	buffer += definitions.filter(row => row.type === 'index').map(row => `${String(row.sql)};`).join('\n');
	// Preserve an AUTOINCREMENT cursor even when all older changelog rows were pruned.
	const sequences = await query('SELECT name, seq FROM sqlite_sequence;');
	buffer += '\nDELETE FROM sqlite_sequence;\n' + sequences.map(row => `INSERT INTO sqlite_sequence(name,seq) VALUES (${quoteValue(row.name)},${quoteValue(row.seq)});`).join('\n');
	const finished: ExportedProgress = { format: 2, phase: 'finishing', prefix: progress.prefix, createdAt: progress.createdAt, parts: await savePart() };
	return { raw: await saveProgress(query, raw, finished), progress: finished };
}

/**
 * Creates or resumes a verified paired backup before a database migration.
 * Files are copied while sync continues; database triggers then pause old
 * writers, including Workers that do not understand newer features, while the
 * database is exported and newer uploads are copied. Progress is saved in D1, so
 * recovery continues an interrupted backup instead of restarting it.
 */
export async function createUpgradeCheckpoint(input: { api: CloudflareApiClient; accountId: string; databaseId: string; bucketName: string; fence: DeploymentFence; onProgress?: (message: string) => void }): Promise<void> {
	const { api, accountId, databaseId, bucketName, fence } = input;
	const query: Query = async (sql, params) => (await api.queryD1(accountId, databaseId, sql, params)).flatMap(result => result.results ?? []);
	const definitions = await query("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type DESC, name;");
	const tables = definitions.filter(row => row.type === 'table').map(row => String(row.name));
	if (!tables.includes('files') || !tables.includes('crate_schema')) throw new Error('Cannot back up an unrecognized server database');
	const context: BackupContext = { api, accountId, bucketName, query, definitions };
	const guarded = tables.filter(table => !CONTROL.has(table));
	const triggers = new Set((await query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'crate_upgrade_%';")).map(row => String(row.name)));
	const paused = guarded.every(table => GUARDED_ACTIONS.every(action => triggers.has(`crate_upgrade_${table}_${action}`)));
	// Keep the fence while any write guard remains, even if the backup fails.
	if (triggers.size) fence.requireVerification();
	let { raw, progress } = await readProgress(query);
	// Guards stay until the upgraded server is verified, so this paused upgrade already has its backup.
	if (progress?.phase === 'complete' && paused) return;
	if (!progress || progress.phase === 'complete') {
		// Pruning runs only between backups, so it never removes copies a backup in progress relies on.
		await pruneUpgradeBackups({ api, accountId, databaseId, bucketName, onProgress: input.onProgress });
		progress = { format: 2, phase: 'copying', prefix: `${UPGRADE_BACKUP_PREFIX}${crypto.randomUUID()}` };
		raw = await saveProgress(query, raw, progress);
	} else if (progress.phase !== 'copying' && !paused) {
		// The export is valid only while writes stayed paused. Copied files remain reusable.
		progress = { format: 2, phase: 'copying', prefix: progress.prefix };
		raw = await saveProgress(query, raw, progress);
	}
	if (progress.phase === 'copying') {
		await copyFilesBeforePause(context, input.onProgress);
		input.onProgress?.('Backing up the server database. Large servers can take several minutes…');
		const dumping: BackupProgress = { format: 2, phase: 'dumping', prefix: progress.prefix, createdAt: new Date().toISOString(), parts: [], table: 0, after: null };
		const next = JSON.stringify(dumping);
		fence.requireVerification();
		// Pausing writers and starting the export commit together.
		await fence.mutate(() => api.queryD1(accountId, databaseId, `${guarded.map(upgradeGuards).join('\n')}
UPDATE maintenance_state SET value = ${quoteValue(next)} WHERE key = '${PROGRESS_KEY}' AND value = ${quoteValue(raw)};`), 'freeze-upgrade-data');
		if ((await readProgress(query)).raw !== next) throw progressChanged();
		raw = next; progress = dumping;
	} else input.onProgress?.('Resuming the server database backup…');
	if (progress.phase === 'dumping') ({ raw, progress } = await dumpDatabase(context, { raw: raw!, progress }));
	if (progress.phase !== 'finishing') throw progressChanged();

	input.onProgress?.('Finishing and verifying the backup archive…');
	const stored = await listBackupObjects(api, accountId, bucketName, `${UPGRADE_BACKUP_STORE}/objects/`);
	const files = new Map<string, FileReference>();
	for await (const page of fileReferences(context)) {
		for (const file of page) {
			const previous = files.get(file.key);
			if (previous && (previous.sha256 !== file.sha256 || previous.size !== file.size)) throw new Error('Conflicting file references in checkpoint');
			files.set(file.key, file);
		}
	}
	for (const file of files.values()) await copyToStore(context, file, stored, true);
	const objects = [...files.values()].map(file => ({ key: file.key, sha256: file.sha256, size: file.size, contentType: 'application/octet-stream' }));
	try {
		await api.throttle();
		const bytes = await api.getRecoveryObject(accountId, bucketName, SHARED_SETTINGS_KEY);
		const sha256 = await sha256Hex(bytes);
		if (!isStored(stored, sha256, bytes.byteLength)) {
			await api.throttle();
			await api.putRecoveryObject(accountId, bucketName, upgradeBackupStoreKey(sha256), bytes);
		}
		objects.push({ key: SHARED_SETTINGS_KEY, sha256, size: bytes.byteLength, contentType: 'application/json' });
	} catch (error) { if (!(error instanceof CloudflareApiError && error.status === 404)) throw error; }
	objects.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
	const parts = await listBackupObjects(api, accountId, bucketName, `${progress.prefix}/objects/`);
	if (progress.parts.some(part => !isStored(parts, part.sha256, part.size))) throw new Error('Database checkpoint verification failed');
	const manifest = JSON.stringify({ format: 2, complete: true, createdAt: progress.createdAt, source: { account: accountId, database: databaseId, bucket: bucketName }, bookmark: null, databaseParts: progress.parts, objects });
	await api.throttle();
	await api.putRecoveryObject(accountId, bucketName, `${progress.prefix}/archive.json`, new TextEncoder().encode(manifest));
	await api.throttle();
	if (await sha256Hex(await api.getRecoveryObject(accountId, bucketName, `${progress.prefix}/archive.json`)) !== await sha256Hex(manifest)) throw new Error('Checkpoint manifest verification failed');
	const complete = JSON.stringify({ ...progress, phase: 'complete' });
	await fence.mutate(() => api.queryD1(accountId, databaseId, `UPDATE maintenance_state SET value = ${quoteValue(complete)} WHERE key = '${PROGRESS_KEY}' AND value = ${quoteValue(raw)};
INSERT OR REPLACE INTO maintenance_state(key, value) VALUES ('crate_upgrade_checkpoint', ${quoteValue(progress.prefix)});`), 'verify-upgrade-checkpoint');
	if ((await readProgress(query)).raw !== complete) throw progressChanged();
}

/** Resumes writers after the upgraded server is verified. Its backup is then complete history. */
export async function releaseUpgradeGuards(api: Pick<CloudflareApiClient, 'queryD1'>, account: string, database: string, fence: DeploymentFence) {
	const rows = (await api.queryD1(account, database, "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'crate_upgrade_%';")).flatMap(result => result.results ?? []);
	if (rows.length) await fence.mutate(() => api.queryD1(account, database, [...rows.map(row => `DROP TRIGGER ${quoteName(String(row.name))};`),
		`DELETE FROM maintenance_state WHERE key = '${PROGRESS_KEY}';`].join('\n')), 'resume-upgraded-server');
}
