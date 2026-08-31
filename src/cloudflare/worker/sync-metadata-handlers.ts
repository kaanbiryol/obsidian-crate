import { normalizeSharedSettingsValue } from '../../sync/shared-settings';
import { corsResponse } from './cors';
import { parseJsonObject, sanitizePath } from './utils';
import { getChangelogBounds } from './sync-storage';
import { BATCH_DOWNLOAD_MAX_FILES } from '../../protocol/sync-limits';

function batchRows<T>(result: unknown): T[] {
	if (!result || typeof result !== 'object') return [];
	const rows = (result as { results?: unknown }).results;
	return Array.isArray(rows) ? rows as T[] : [];
}

export async function handleHealth(): Promise<Response> {
	return corsResponse({ status: 'ok', timestamp: new Date().toISOString() });
}

export async function handleCheckChanges(request: Request, db: D1Database): Promise<Response> {
	const url = new URL(request.url);
	const since = parseInt(url.searchParams.get('since') || '0', 10);
	if (isNaN(since) || since < 0) return corsResponse({ error: 'Invalid since parameter' }, 400);
	const { lastSeq, minSeq } = await getChangelogBounds(db);
	const cursorExpired = since > 0 && (minSeq === null || since + 1 < minSeq);
	return corsResponse({ lastSeq, hasChanges: lastSeq > since, ...(cursorExpired && { cursorExpired: true }) });
}

export async function handleGetChanges(request: Request, db: D1Database): Promise<Response> {
	const url = new URL(request.url);
	const since = parseInt(url.searchParams.get('since') || '0', 10);
	if (isNaN(since) || since < 0) return corsResponse({ error: 'Invalid since parameter' }, 400);

	const [changesResult, boundsResult] = await db.batch([
		db.prepare('SELECT seq, path, action, hash, size, created_at FROM changelog WHERE seq > ? ORDER BY seq ASC LIMIT 5000').bind(since),
		db.prepare('SELECT MAX(seq) as lastSeq, MIN(seq) as minSeq FROM changelog'),
	]);
	const changeRows = batchRows(changesResult);
	const [bounds] = batchRows<{ lastSeq: number | null; minSeq: number | null }>(boundsResult);
	const lastSeq = bounds?.lastSeq ?? 0;
	const minSeq = bounds?.minSeq ?? null;
	const cursorExpired = since > 0 && (minSeq === null || since + 1 < minSeq);

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
		? db.prepare(`SELECT path, hash, size, modified FROM files
			WHERE path > ? ORDER BY path ASC LIMIT ?`).bind(after, requestedLimit + 1)
		: db.prepare('SELECT path, hash, size, modified FROM files ORDER BY path ASC LIMIT ?')
			.bind(requestedLimit + 1);
	const [filesResult, seqResult] = await db.batch([
		filesStatement,
		db.prepare('SELECT MAX(seq) as lastSeq FROM changelog'),
	]);
	const filesRows = batchRows<{ path: string; hash: string; size: number; modified: string }>(filesResult);
	const seqRows = batchRows<{ lastSeq: number | null }>(seqResult);
	const hasMore = filesRows.length > requestedLimit;
	const rows = hasMore ? filesRows.slice(0, requestedLimit) : filesRows;
	const files: Record<string, { hash: string; size: number; modified: string }> = {};
	for (const row of rows) {
		files[row.path] = { hash: row.hash, size: row.size, modified: row.modified };
	}
	const lastSeq = seqRows[0]?.lastSeq ?? 0;
	const snapshotSeq = requestedSnapshotSeq ?? lastSeq;
	const nextCursor = hasMore ? rows.at(-1)?.path : undefined;
	const paginatedRequest = url.searchParams.has('limit') || url.searchParams.has('after');

	return corsResponse({
		version: 1,
		files,
		lastSeq,
		snapshotSeq,
		hasMore,
		...(nextCursor && { nextCursor }),
		...(!paginatedRequest && hasMore && { truncated: true }),
	});
}

export async function handleGetFileMetadata(request: Request, db: D1Database): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) return parsedBody.response;

	const rawPaths = parsedBody.value.paths;
	if (!Array.isArray(rawPaths) || rawPaths.length > BATCH_DOWNLOAD_MAX_FILES) {
		return corsResponse({ error: `paths must contain at most ${BATCH_DOWNLOAD_MAX_FILES} entries` }, 400);
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
		`SELECT path, hash, size, modified FROM files WHERE path IN (${placeholders})`,
	).bind(...paths).all();
	const rows = Array.isArray(result.results)
		? result.results as Array<{ path: string; hash: string; size: number; modified: string }>
		: [];
	const files: Record<string, { hash: string; size: number; modified: string }> = {};
	for (const row of rows) {
		files[row.path] = { hash: row.hash, size: row.size, modified: row.modified };
	}
	return corsResponse({ files });
}

export async function handleGetSettings(bucket: R2Bucket): Promise<Response> {
	const obj = await bucket.get('__crate__/settings.json');
	if (!obj) return corsResponse({ settings: null, settingsVersion: null });
	try {
		const body = await obj.text();
		return corsResponse({
			settings: normalizeSharedSettingsValue(JSON.parse(body)),
			settingsVersion: obj.etag,
		});
	} catch {
		return corsResponse({ settings: null, settingsVersion: obj.etag });
	}
}

export async function handlePutSettings(request: Request, bucket: R2Bucket): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const settings = normalizeSharedSettingsValue(parsedBody.value.settings);
	const expectedVersion = parsedBody.value.expectedVersion;
	if (!settings) {
		return corsResponse({ error: 'Invalid shared settings payload' }, 400);
	}
	if (expectedVersion !== null && typeof expectedVersion !== 'string') {
		return corsResponse({ error: 'expectedVersion must be a string or null' }, 400);
	}

	const current = await bucket.head('__crate__/settings.json');
	if ((current?.etag ?? null) !== expectedVersion) {
		return corsResponse({ error: 'Shared settings changed on another device' }, 409);
	}
	const written = await bucket.put('__crate__/settings.json', JSON.stringify(settings), {
		onlyIf: current
			? { etagMatches: current.etag }
			: { etagDoesNotMatch: '*' },
	});
	if (!written) return corsResponse({ error: 'Shared settings changed on another device' }, 409);
	return corsResponse({ success: true, settingsVersion: written.etag });
}
