import { normalizeSharedSettingsValue } from '../../sync/shared-settings';
import { corsResponse } from './cors';
import { parseJsonObject } from './utils';
import { getChangelogBounds } from './sync-storage';

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
	const MAX_MANIFEST_FILES = 200000;
	const [filesResult, seqResult] = await db.batch([
		db.prepare('SELECT path, hash, size, modified FROM files LIMIT 200001'),
		db.prepare('SELECT MAX(seq) as lastSeq FROM changelog'),
	]);
	const filesRows = batchRows<{ path: string; hash: string; size: number; modified: string }>(filesResult);
	const seqRows = batchRows<{ lastSeq: number | null }>(seqResult);
	const truncated = filesRows.length > MAX_MANIFEST_FILES;
	const rows = truncated ? filesRows.slice(0, MAX_MANIFEST_FILES) : filesRows;
	const files: Record<string, { hash: string; size: number; modified: string }> = {};
	for (const row of rows) {
		files[row.path] = { hash: row.hash, size: row.size, modified: row.modified };
	}
	const lastSeq = seqRows[0]?.lastSeq ?? 0;

	return corsResponse({ version: 1, files, lastSeq, ...(truncated && { truncated: true }) });
}

export async function handleGetSettings(bucket: R2Bucket): Promise<Response> {
	const obj = await bucket.get('__crate__/settings.json');
	if (!obj) return corsResponse({ settings: null });
	try {
		const body = await obj.text();
		return corsResponse({ settings: normalizeSharedSettingsValue(JSON.parse(body)) });
	} catch {
		return corsResponse({ settings: null });
	}
}

export async function handlePutSettings(request: Request, bucket: R2Bucket): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const settings = normalizeSharedSettingsValue(parsedBody.value.settings);
	if (!settings) {
		return corsResponse({ error: 'Invalid shared settings payload' }, 400);
	}

	await bucket.put('__crate__/settings.json', JSON.stringify(settings));
	return corsResponse({ success: true });
}
