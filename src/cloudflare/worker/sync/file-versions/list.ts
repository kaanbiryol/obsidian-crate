import { corsResponse } from '../../http/cors';
import { queryRows } from '../../d1/db';
import { sanitizePath } from '../../http/request-validation';
import { isSyncDate, isSyncRevision } from '../../../../protocol/sync-validation';
import type { RemoteFileVersion } from '../../../../protocol/sync-types';
import { descriptorField } from '../../encryption/state';

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
	// One file's versions page by `file_versions_path_created_key_idx`. Every version
	// pages by its expiry, which is its creation time plus the retention period except for
	// a deleted file's copy, kept from its deletion. `file_versions_expires_at_idx` orders
	// it with the row ID, which the index holds: a restore or a folder delete gives many
	// versions one expiry, and a page must not sort them all.
	const order = path ? 'created_at' : 'expires_at', tie = path ? 'storage_key' : 'id';
	const cursorFormat = path ? 1 : 3;
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
	const rows = await queryRows<RemoteFileVersion & { id: number; descriptor: string | null }>(db.prepare('SELECT id, storage_key, path, hash, size, reason, created_at, expires_at, descriptor FROM file_versions WHERE '
		+ clauses.join(' AND ') + ` ORDER BY ${order} DESC, ${tie} DESC LIMIT ?`).bind(...values, PAGE_SIZE + 1));
	const hasMore = rows.length > PAGE_SIZE;
	const page = rows.slice(0, PAGE_SIZE);
	const versions: RemoteFileVersion[] = page.map(({ id: _id, descriptor, ...version }) => ({ ...version, ...descriptorField(descriptor) }));
	const last = page.at(-1);
	const nextCursor = hasMore && last ? btoa(JSON.stringify([cursorFormat, path ? last.created_at : last.expires_at,
		path ? encodeURIComponent(last.storage_key) : last.id, encodeURIComponent(path ?? ''), encodeURIComponent(search)])) : undefined;
	return corsResponse({ versions, hasMore, ...(nextCursor ? { nextCursor } : {}) });
}
