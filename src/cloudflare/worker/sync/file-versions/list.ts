import { corsResponse } from '../../http/cors';
import { queryRows } from '../../d1/db';
import { sanitizePath } from '../../http/request-validation';
import { isSyncDate, isSyncRevision } from '../../../../protocol/sync-validation';
import type { RemoteFileVersion } from '../../../../protocol/sync-types';
import { descriptorField } from '../../encryption/state';
import { FILE_VERSION_CUTOFF_SQL, HISTORY_RETENTION_MS_SQL } from '../storage';

const PAGE_SIZE = 100;
/** Versions a search reads per request. A rare name would otherwise read every retained
 * version; a window with fewer matches than a page answers what it found and a cursor
 * after its last version, so the next request continues from there. */
export const SEARCH_WINDOW = 2000;

export async function handleListFileVersions(request: Request, db: D1Database): Promise<Response> {
	const params = new URL(request.url).searchParams;
	const rawPath = params.get('path');
	const path = rawPath === null ? null : sanitizePath(rawPath);
	const search = params.get('search') ?? '';
	// Literal filename search must reject control characters.
	// eslint-disable-next-line no-control-regex -- Filename searches reject control characters.
	if (rawPath !== null && !path || search.length > 1024 || /[\u0000-\u001f\u007f]/.test(search)) return corsResponse({ error: 'Invalid path search' }, 400);
	const clauses = [`kept_at > ${FILE_VERSION_CUTOFF_SQL}`];
	const values: (string | number)[] = [Date.now()];
	if (path) { clauses.push('path = ?'); values.push(path); }
	// One file's versions page by `file_versions_path_created_key_idx`. Every version
	// pages by when it was kept, which is its creation time except for a deleted file's
	// copy, kept from its deletion. `file_versions_kept_at_idx` orders it with the row ID,
	// which the index holds: a restore or a folder delete keeps many versions at once, and
	// a page must not sort them all.
	const order = path ? 'created_at' : 'kept_at', tie = path ? 'storage_key' : 'id';
	const cursorFormat = path ? 1 : 4;
	const rawCursor = params.get('cursor');
	if (rawCursor !== null) {
		try {
			if (rawCursor.length > 8192) throw new Error();
			const cursor: unknown = JSON.parse(atob(rawCursor));
			if (!Array.isArray(cursor) || cursor.length !== 5 || cursor[0] !== cursorFormat
				|| !(path ? isSyncDate(cursor[1]) : Number.isSafeInteger(cursor[1]))
				|| (path ? typeof cursor[2] !== 'string' || !isSyncRevision(decodeURIComponent(cursor[2])) : !Number.isSafeInteger(cursor[2]))
				|| cursor[3] !== encodeURIComponent(path ?? '') || cursor[4] !== encodeURIComponent(search)) throw new Error();
			clauses.push(`(${order}, ${tie}) < (?, ?)`);
			values.push(cursor[1] as string | number, path ? decodeURIComponent(cursor[2] as string) : cursor[2] as number);
		} catch { return corsResponse({ error: 'Invalid retained-version cursor; restart the search' }, 400); }
	}
	const columns = `id, storage_key, path, hash, size, reason, created_at, kept_at, kept_at + ${HISTORY_RETENTION_MS_SQL} AS expires_at, descriptor`;
	const where = clauses.join(' AND '), sort = `${order} DESC, ${tie} DESC`;
	type Row = RemoteFileVersion & { id: number; kept_at: number; descriptor: string | null };
	// A search filters one bounded window of versions; its last version is where the next request starts.
	const window = `SELECT id, ${order} AS position, ${tie} AS tie, path FROM file_versions WHERE ${where} ORDER BY ${sort} LIMIT ${SEARCH_WINDOW}`;
	const [rows, end] = search
		? await Promise.all([
			queryRows<Row>(db.prepare(`SELECT ${columns} FROM file_versions WHERE id IN (SELECT id FROM (${window})
				WHERE instr(lower(path), lower(?)) > 0) ORDER BY ${sort} LIMIT ?`).bind(...values, search, PAGE_SIZE + 1)),
			db.prepare(`SELECT position, tie, COUNT(*) OVER () AS scanned FROM (${window}) ORDER BY position ASC, tie ASC LIMIT 1`)
				.bind(...values).first<{ position: string | number; tie: string | number; scanned: number }>(),
		])
		: [await queryRows<Row>(db.prepare(`SELECT ${columns} FROM file_versions WHERE ${where} ORDER BY ${sort} LIMIT ?`).bind(...values, PAGE_SIZE + 1)), null];
	const page = rows.slice(0, PAGE_SIZE);
	const versions: RemoteFileVersion[] = page.map(({ id: _id, kept_at: _keptAt, descriptor, ...version }) => ({ ...version, ...descriptorField(descriptor) }));
	const last = page.at(-1);
	const position = rows.length > PAGE_SIZE && last ? { position: path ? last.created_at : last.kept_at, tie: path ? last.storage_key : last.id }
		: end && end.scanned >= SEARCH_WINDOW ? end : null;
	const nextCursor = position ? btoa(JSON.stringify([cursorFormat, position.position,
		path ? encodeURIComponent(position.tie) : position.tie, encodeURIComponent(path ?? ''), encodeURIComponent(search)])) : undefined;
	return corsResponse({ versions, hasMore: nextCursor !== undefined, ...(nextCursor ? { nextCursor } : {}) });
}
