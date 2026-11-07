import type { CloudflareApiClient } from '../cloudflare-api';
import { isSha256Hex } from '../../platform/validation';
import { sha256Hex } from '../../platform/sha256';
import { UPGRADE_BACKUP_PREFIX, UPGRADE_BACKUP_STORE } from '../../protocol/storage-keys';
import { quoteName } from '../d1-sql';

export interface BackupSource { account: string; database: string; bucket: string }
interface BackupObject { key: string; sha256: string; size: number; contentType?: string }
export interface BackupPart { sha256: string; size: number }
/** Format 2 stores the database in ordered parts under the backup, named by
 * checksum, and shares checksum-named file copies through the backup store. */
export interface UpgradeBackup { format: 2; complete: true; createdAt: string; source: BackupSource; objects: BackupObject[]; databaseParts: BackupPart[] }
export interface BackupChoice { prefix: string; manifest: UpgradeBackup; hash: string }
export type Cell = string | number | null;
export interface BackupRow { table: string; columns: string[]; values: Cell[] }
/** One backup's location. The shared backup store uses the same shape. */
export const BACKUP_PREFIX = /^__crate__\/backups\/schema-upgrade-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
/** A backup's manifest or one of its checksum-named objects. */
export const BACKUP_OBJECT = new RegExp(`${BACKUP_PREFIX.source.slice(0, -1)}\\/(?:archive\\.json|objects\\/[a-f0-9]{64})$`);
export const manifestKey = (prefix: string) => `${prefix}/archive.json`;
/** Quotes an identifier read from a downloaded backup, accepting only names like Crate's schema uses. */
export const quote = (name: string) => { if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('Unsupported backup identifier'); return quoteName(name); };

/** Items of a cursor-paged R2 listing in order. A repeated cursor throws `stalled`. */
export async function* pagedListing<T>(listPage: (cursor: string | undefined) => Promise<{ items: readonly T[]; cursor?: string }>,
	stalled = 'Backup listing did not advance'): AsyncGenerator<T> {
	const cursors = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await listPage(cursor);
		yield* page.items;
		cursor = page.cursor;
		if (cursor && cursors.has(cursor)) throw new Error(stalled);
		if (cursor) cursors.add(cursor);
	} while (cursor);
}

/** Keys below the upgrade backup prefix in listing order, stopping at the shared
 * store, which sorts after every backup and holds no manifests. */
export async function* listBackupKeys(api: Pick<CloudflareApiClient, 'listR2Objects'>, account: string, bucket: string, beforePage?: () => Promise<void>): AsyncGenerator<string> {
	for await (const key of pagedListing(async cursor => {
		await beforePage?.();
		const page = await api.listR2Objects(account, bucket, cursor, UPGRADE_BACKUP_PREFIX);
		return { items: page.keys, cursor: page.cursor };
	})) {
		if (key.startsWith(`${UPGRADE_BACKUP_STORE}/`)) return;
		yield key;
	}
}

/** Encodes a complete format 2 manifest, the bytes `completeManifest` decodes. */
export function encodeManifest(manifest: Omit<UpgradeBackup, 'format' | 'complete'>): Uint8Array {
	const { createdAt, source: { account, database, bucket }, databaseParts, objects } = manifest;
	return new TextEncoder().encode(JSON.stringify({ format: 2, complete: true, createdAt, source: { account, database, bucket }, bookmark: null, databaseParts, objects }));
}

/** Decodes a manifest that claims to be a complete format 2 backup. Callers validate the rest. */
export function completeManifest(bytes: Uint8Array): UpgradeBackup | null {
	const value = JSON.parse(new TextDecoder().decode(bytes)) as UpgradeBackup | null;
	return value?.format === 2 && value.complete === true && Number.isFinite(Date.parse(value.createdAt)) && Array.isArray(value.objects) ? value : null;
}

export async function readBackup(api: Pick<CloudflareApiClient, 'getRecoveryObject'>, source: BackupSource, prefix: string): Promise<BackupChoice> {
	if (!BACKUP_PREFIX.test(prefix) || prefix === UPGRADE_BACKUP_STORE) throw new Error('Invalid backup location');
	const bytes = await api.getRecoveryObject(source.account, source.bucket, manifestKey(prefix));
	if (bytes.length > 32 * 1024 * 1024) throw new Error('Backup inventory is too large for in-app recovery');
	const value = completeManifest(bytes);
	const database = Array.isArray(value?.databaseParts) && value.databaseParts.length > 0
		&& value.databaseParts.every(part => part && isSha256Hex(part.sha256) && Number.isSafeInteger(part.size) && part.size > 0);
	if (!value || !database || !value.source
		|| Object.keys(source).some(key => source[key as keyof BackupSource] !== value.source[key as keyof BackupSource])) throw new Error('Backup is incomplete or belongs to a different server');
	const keys = new Set<string>();
	for (const item of value.objects) {
		if (!item || typeof item.key !== 'string' || !item.key || item.key.length > 1024 || keys.has(item.key)
			|| !isSha256Hex(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0) throw new Error('Invalid backup inventory');
		keys.add(item.key);
	}
	return { prefix, manifest: value, hash: await sha256Hex(bytes) };
}


const IN_APP_DATABASE_LIMIT = 128 * 1024 * 1024;
const tooLarge = () => new Error('Backup database is too large for in-app recovery. Use the recovery CLI.');
/** Reads and verifies the backup's SQL export. Parts end at statement boundaries. */
export async function readBackupDatabase(api: Pick<CloudflareApiClient, 'getRecoveryObject'>, source: BackupSource, backup: BackupChoice): Promise<string> {
	const { manifest, prefix } = backup;
	if (manifest.databaseParts.reduce((total, part) => total + part.size, 0) > IN_APP_DATABASE_LIMIT) throw tooLarge();
	let sql = '';
	for (const part of manifest.databaseParts) {
		const bytes = await api.getRecoveryObject(source.account, source.bucket, `${prefix}/objects/${part.sha256}`);
		if (bytes.length !== part.size || await sha256Hex(bytes) !== part.sha256) throw new Error('Backup database checksum does not match');
		sql += new TextDecoder().decode(bytes);
	}
	return sql;
}

/** Decode only the literal INSERTs emitted by our checkpoint writer. Never execute downloaded SQL. */
export function parseBackupRows(sql: string): BackupRow[] {
	const statements: string[] = [];
	let start = 0, quoted = '';
	for (let i = 0; i < sql.length; i++) {
		const char = sql[i];
		if (quoted) { if (char === quoted) { if (sql[i + 1] === quoted) i++; else quoted = ''; } }
		else if (char === "'" || char === '"') quoted = char;
		else if (char === ';') { statements.push(sql.slice(start, i).trim()); start = i + 1; }
	}
	if (quoted || sql.slice(start).trim()) throw new Error('Incomplete backup database');
	const rows: BackupRow[] = [];
	for (const statement of statements) {
		if (!statement || /^PRAGMA foreign_keys=OFF$/i.test(statement) || /^CREATE (?:TABLE|(?:UNIQUE )?INDEX)\b/i.test(statement) || statement === 'DELETE FROM sqlite_sequence') continue;
		const insert = /^INSERT INTO "([a-z_][a-z0-9_]*)"\s*\(([^)]+)\) VALUES \(([\s\S]*)\)$/i.exec(statement)
			?? /^INSERT INTO (sqlite_sequence)\(([^)]+)\) VALUES \(([\s\S]*)\)$/i.exec(statement);
		if (!insert) throw new Error('Unsupported statement in backup database');
		const columns = insert[2]!.split(',').map(value => value.trim().replace(/^"([a-z_][a-z0-9_]*)"$/, '$1'));
		columns.forEach(quote);
		const values: Cell[] = [];
		const data = insert[3]!; let offset = 0;
		while (offset < data.length) {
			while (/\s/.test(data[offset] ?? '') && offset < data.length) offset++;
			if (data[offset] === "'") {
				offset++; let value = '', closed = false;
				while (offset < data.length) {
					if (data[offset] === "'") { if (data[offset + 1] === "'") { value += "'"; offset += 2; } else { offset++; closed = true; break; } }
					else value += data[offset++];
				}
				if (!closed) throw new Error('Invalid quoted backup value');
				values.push(value);
			} else {
				const end = data.indexOf(',', offset), token = data.slice(offset, end < 0 ? undefined : end).trim();
				if (token === 'NULL') values.push(null);
				else if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(token) && Number.isFinite(Number(token)) && (!Number.isInteger(Number(token)) || Number.isSafeInteger(Number(token)))) values.push(Number(token));
				else throw new Error('Non-literal backup value');
				offset = end < 0 ? data.length : end;
			}
			while (offset < data.length && /\s/.test(data[offset]!)) offset++;
			if (offset < data.length && (data[offset++] !== ',' || !data.slice(offset).trim())) throw new Error('Invalid backup value separator');
		}
		if (values.length !== columns.length || new Set(columns).size !== columns.length) throw new Error('Backup row shape does not match');
		rows.push({ table: insert[1]!, columns, values });
	}
	return rows;
}
