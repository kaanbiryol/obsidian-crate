import { corsResponse } from './cors';
import { queryRows } from './db';
import { sanitizePath } from './utils';
import { isSyncDate, isSyncRevision } from '../../protocol/sync-validation';
import type { RemoteFileVersion } from '../../protocol/sync-types';

const PAGE_SIZE = 100;

export async function handleListFileVersions(request: Request, db: D1Database): Promise<Response> {
	const params = new URL(request.url).searchParams;
	const rawPath = params.get('path');
	const path = rawPath === null ? null : sanitizePath(rawPath);
	const search = params.get('search') ?? '';
	// Literal filename search must reject control characters.
	// eslint-disable-next-line no-control-regex -- Filename searches reject control characters.
	if (rawPath !== null && !path || search.length > 1024 || /[\u0000-\u001f\u007f]/.test(search)) return corsResponse({ error: 'Invalid path search' }, 400);
	const clauses = ['expires_at > ?'];
	const values: (string | number)[] = [Date.now()];
	if (path) { clauses.push('path = ?'); values.push(path); }
	if (search) { clauses.push('instr(lower(path), lower(?)) > 0'); values.push(search); }
	const rawCursor = params.get('cursor');
	if (rawCursor !== null) {
		try {
			if (rawCursor.length > 8192) throw new Error();
			const cursor: unknown = JSON.parse(atob(rawCursor));
			if (!Array.isArray(cursor) || cursor.length !== 5 || cursor[0] !== 1 || !isSyncDate(cursor[1])
				|| typeof cursor[2] !== 'string' || !isSyncRevision(decodeURIComponent(cursor[2]))
				|| cursor[3] !== encodeURIComponent(path ?? '') || cursor[4] !== encodeURIComponent(search)) throw new Error();
			clauses.push('(created_at, storage_key) < (?, ?)');
			values.push(cursor[1], decodeURIComponent(cursor[2]));
		} catch { return corsResponse({ error: 'Invalid retained-version cursor; restart the search' }, 400); }
	}
	const rows = await queryRows<RemoteFileVersion>(db.prepare('SELECT storage_key, path, hash, size, reason, created_at, expires_at FROM file_versions WHERE '
		+ clauses.join(' AND ') + ' ORDER BY created_at DESC, storage_key DESC LIMIT ?').bind(...values, PAGE_SIZE + 1));
	const hasMore = rows.length > PAGE_SIZE;
	const versions = rows.slice(0, PAGE_SIZE);
	const last = versions.at(-1);
	const nextCursor = hasMore && last ? btoa(JSON.stringify([1, last.created_at, encodeURIComponent(last.storage_key), encodeURIComponent(path ?? ''), encodeURIComponent(search)])) : undefined;
	return corsResponse({ versions, hasMore, ...(nextCursor ? { nextCursor } : {}) });
}
