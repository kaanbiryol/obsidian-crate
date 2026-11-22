import { portablePathKey } from '../../../protocol/portable-path';
import { MAX_ENCRYPTED_SETTINGS_REQUEST_BYTES, MAX_SHARED_SETTINGS_BYTES, validateEncryptedSettings } from '../../../encryption/settings-format';
import { normalizeSharedSettingsValue } from '../../../protocol/shared-settings';
import { corsResponse } from '../http/cors';
import { parseJsonObject, sanitizePath } from '../http/request-validation';
import { CHANGELOG_BOUNDS_SQL, isChangelogCursorExpired, parseChangelogSince, STORAGE_ID_SQL, storageIdField } from './storage';
import { MAX_BATCH_DOWNLOAD_FILES } from './storage';
import type { FileEntry } from '../../../protocol/sync-types';
import { createPathRecord } from '../../../protocol/path-record';
import { descriptorField, encryptionWriteGuard } from '../encryption/state';
import type { EncryptionServerState } from '../../../encryption/server-state';
import { changedRows } from '../d1/db';

function batchRows<T>(result: unknown): T[] {
	if (!result || typeof result !== 'object') return [];
	const rows = (result as { results?: unknown }).results;
	return Array.isArray(rows) ? rows as T[] : [];
}

export async function handleCheckChanges(request: Request, db: D1Database): Promise<Response> {
	const since = parseChangelogSince(new URL(request.url));
	if (since === null) return corsResponse({ error: 'Invalid since parameter' }, 400);
	const [boundsResult, storageResult] = await db.batch([db.prepare(CHANGELOG_BOUNDS_SQL), db.prepare(STORAGE_ID_SQL)]);
	const [row] = batchRows<{ lastSeq: number | null; minSeq: number | null; snapshotSeq: number | null }>(boundsResult);
	const bounds = { lastSeq: row?.lastSeq ?? 0, minSeq: row?.minSeq ?? null, snapshotSeq: row?.snapshotSeq ?? 0 };
	const cursorExpired = isChangelogCursorExpired(since, bounds);
	return corsResponse({ lastSeq: bounds.lastSeq, hasChanges: bounds.lastSeq > since, ...(cursorExpired && { cursorExpired: true }),
		...await storageIdField(db, batchRows<{ value: string }>(storageResult)[0]?.value ?? null) });
}

export async function handleGetChanges(request: Request, db: D1Database): Promise<Response> {
	const since = parseChangelogSince(new URL(request.url));
	if (since === null) return corsResponse({ error: 'Invalid since parameter' }, 400);

	const [changesResult, boundsResult] = await db.batch([
		db.prepare('SELECT seq, path, action, hash, size, revision, created_at, descriptor FROM changelog WHERE seq > ? ORDER BY seq ASC LIMIT 5000').bind(since),
		db.prepare(CHANGELOG_BOUNDS_SQL),
	]);
	const changeRows = batchRows<Record<string, unknown> & { descriptor: string | null }>(changesResult)
		.map(({ descriptor, ...change }) => ({ ...change, ...descriptorField(descriptor) }));
	const [bounds] = batchRows<{ lastSeq: number | null; minSeq: number | null; snapshotSeq?: number }>(boundsResult);
	const lastSeq = bounds?.lastSeq ?? 0;
	const cursorExpired = isChangelogCursorExpired(since, { lastSeq, minSeq: bounds?.minSeq ?? null, snapshotSeq: bounds?.snapshotSeq ?? 0 });

	return corsResponse({
		changes: changeRows,
		lastSeq,
		hasMore: changeRows.length === 5000,
		...(cursorExpired && { cursorExpired: true }),
	});
}

export async function handleGetManifest(request: Request, db: D1Database): Promise<Response> {
	const url = new URL(request.url);
	const requestedLimit = Number(url.searchParams.get('limit') || '5000');
	if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 5000) {
		return corsResponse({ error: 'Manifest page limit must be between 1 and 5000' }, 400);
	}
	const after = url.searchParams.get('after');
	const requestedSnapshotSeq = url.searchParams.has('snapshotSeq')
		? Number(url.searchParams.get('snapshotSeq'))
		: null;
	if (requestedSnapshotSeq !== null && (!Number.isSafeInteger(requestedSnapshotSeq) || requestedSnapshotSeq < 0)) {
		return corsResponse({ error: 'Invalid manifest snapshot cursor' }, 400);
	}
	const filesStatement = after
		? db.prepare(`SELECT path, hash, size, modified, storage_key AS revision, descriptor FROM files
			WHERE portable_path > ? ORDER BY portable_path ASC LIMIT ?`).bind(portablePathKey(after), requestedLimit + 1)
		: db.prepare('SELECT path, hash, size, modified, storage_key AS revision, descriptor FROM files ORDER BY portable_path ASC LIMIT ?')
			.bind(requestedLimit + 1);
	const [filesResult, seqResult] = await db.batch([
		filesStatement,
		db.prepare(CHANGELOG_BOUNDS_SQL),
	]);
	const filesRows = batchRows<{ path: string; hash: string; size: number; modified: string; revision?: string; descriptor: string | null }>(filesResult);
	const seqRows = batchRows<{ lastSeq: number | null }>(seqResult);
	const hasMore = filesRows.length > requestedLimit;
	const rows = hasMore ? filesRows.slice(0, requestedLimit) : filesRows;
	const files = createPathRecord<FileEntry>();
	for (const row of rows) {
		files[row.path] = { hash: row.hash, size: row.size, modified: row.modified, revision: row.revision, ...descriptorField(row.descriptor) };
	}
	const lastSeq = seqRows[0]?.lastSeq ?? 0;
	const snapshotSeq = requestedSnapshotSeq ?? lastSeq;
	const nextCursor = hasMore ? rows.at(-1)?.path : undefined;

	return corsResponse({
		version: 1,
		files,
		lastSeq,
		snapshotSeq,
		hasMore,
		...(nextCursor && { nextCursor }),
	});
}

export async function handleGetFileMetadata(request: Request, db: D1Database): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) return parsedBody.response;

	const rawPaths = parsedBody.value.paths;
	if (!Array.isArray(rawPaths) || rawPaths.length > MAX_BATCH_DOWNLOAD_FILES) {
		return corsResponse({ error: `paths must contain at most ${MAX_BATCH_DOWNLOAD_FILES} entries` }, 400);
	}

	const paths: string[] = [];
	for (const rawPath of rawPaths) {
		if (typeof rawPath !== 'string') return corsResponse({ error: 'Invalid path' }, 400);
		const path = sanitizePath(rawPath);
		if (!path) return corsResponse({ error: 'Invalid path' }, 400);
		paths.push(path);
	}
	if (new Set(paths).size !== paths.length) {
		return corsResponse({ error: 'Duplicate paths are not allowed' }, 400);
	}
	if (paths.length === 0) return corsResponse({ files: {} });

	const placeholders = paths.map(() => '?').join(', ');
	const result = await db.prepare(
		`SELECT path, hash, size, modified, storage_key AS revision, descriptor FROM files WHERE portable_path IN (${placeholders})`,
	).bind(...paths.map(portablePathKey)).all();
	const rows = Array.isArray(result.results)
		? result.results as Array<{ path: string; hash: string; size: number; modified: string; revision?: string; descriptor: string | null }>
		: [];
	const files = createPathRecord<FileEntry>();
	for (const row of rows) {
		if (!paths.includes(row.path)) continue;
		files[row.path] = { hash: row.hash, size: row.size, modified: row.modified, revision: row.revision, ...descriptorField(row.descriptor) };
	}
	return corsResponse({ files });
}

/** GET and PUT /settings. Shared settings live in `server_state`: plaintext JSON, or in an
 * encrypted vault a record sealed under the vault key. A write replaces the version it was
 * given and is guarded by the encryption state it was validated against. */
export async function handleSharedSettings(request: Request, db: D1Database, state: EncryptionServerState | null): Promise<Response> {
	if (request.method === 'GET') {
		const row = await db.prepare('SELECT settings, settings_version FROM server_state WHERE id = 1')
			.first<{ settings: string | null; settings_version: string | null }>();
		if (row?.settings == null) return corsResponse({ settings: null, settingsVersion: null });
		const stored: unknown = JSON.parse(row.settings);
		return corsResponse({ settings: state ? stored : normalizeSharedSettingsValue(stored), settingsVersion: row.settings_version });
	}
	const parsed = await parseJsonObject(request, state ? MAX_ENCRYPTED_SETTINGS_REQUEST_BYTES : MAX_SHARED_SETTINGS_BYTES);
	if (!parsed.ok) return parsed.response;
	const { settings, expectedVersion } = parsed.value;
	let value: unknown;
	if (state) {
		try { validateEncryptedSettings(settings); }
		catch { return corsResponse({ error: 'Encrypted shared settings are required' }, 400); }
		if (settings.vaultId !== state.vaultId || settings.keyId !== state.keyId) return corsResponse({ error: 'Shared settings use the wrong encryption key' }, 409);
		value = settings;
	} else {
		value = normalizeSharedSettingsValue(settings);
		if (!value) return corsResponse({ error: 'Invalid shared settings payload' }, 400);
	}
	if (expectedVersion !== null && (typeof expectedVersion !== 'string' || expectedVersion.length > 128)) return corsResponse({ error: 'expectedVersion must be a string or null' }, 400);
	const guard = encryptionWriteGuard(state);
	const settingsVersion = crypto.randomUUID();
	const result = await db.prepare(`INSERT INTO server_state (id, settings, settings_version)
		SELECT 1, ?, ? WHERE ${guard.sql} AND (SELECT settings_version FROM server_state WHERE id = 1) IS ?
		ON CONFLICT(id) DO UPDATE SET settings = excluded.settings, settings_version = excluded.settings_version`)
		.bind(JSON.stringify(value), settingsVersion, ...guard.args, expectedVersion).run();
	return changedRows(result) === 1 ? corsResponse({ success: true, settingsVersion })
		: corsResponse({ error: 'Shared settings changed on another device' }, 409);
}
