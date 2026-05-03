import { normalizeSharedSettingsValue } from '../../sync/shared-settings';
import { corsResponse } from './cors';
import { queryRows } from './db';
import { parseJsonObject } from './utils';
import type { Env } from './types';
import { ensureSyncMetadata, getChangelogBounds } from './sync-storage';

export async function handleHealth(): Promise<Response> {
	return corsResponse({ status: 'ok', timestamp: new Date().toISOString() });
}

export async function handleCheckChanges(request: Request, db: D1Database): Promise<Response> {
	await ensureSyncMetadata(db);
	const url = new URL(request.url);
	const since = parseInt(url.searchParams.get('since') || '0', 10);
	if (isNaN(since) || since < 0) return corsResponse({ error: 'Invalid since parameter' }, 400);
	const { lastSeq, minSeq } = await getChangelogBounds(db);
	const cursorExpired = since > 0 && (minSeq === null || since < minSeq);
	return corsResponse({ lastSeq, hasChanges: lastSeq > since, ...(cursorExpired && { cursorExpired: true }) });
}

export async function handleGetChanges(request: Request, db: D1Database): Promise<Response> {
	const url = new URL(request.url);
	const since = parseInt(url.searchParams.get('since') || '0', 10);
	if (isNaN(since) || since < 0) return corsResponse({ error: 'Invalid since parameter' }, 400);

	await ensureSyncMetadata(db);
	const changeRows = await queryRows(
		db.prepare('SELECT seq, path, action, hash, size, created_at FROM changelog WHERE seq > ? ORDER BY seq ASC LIMIT 5000').bind(since)
	);
	const { lastSeq, minSeq } = await getChangelogBounds(db);
	const cursorExpired = since > 0 && (minSeq === null || since < minSeq);

	return corsResponse({
		changes: changeRows,
		lastSeq,
		hasMore: changeRows.length === 5000,
		...(cursorExpired && { cursorExpired: true }),
	});
}

export async function handleGetManifest(request: Request, db: D1Database): Promise<Response> {
	await ensureSyncMetadata(db);

	const MAX_MANIFEST_FILES = 200000;
	const filesRows = await queryRows<{ path: string; hash: string; size: number; modified: string }>(
		db.prepare('SELECT path, hash, size, modified FROM files LIMIT 200001')
	);
	const seqRows = await queryRows<{ lastSeq: number }>(db.prepare('SELECT MAX(seq) as lastSeq FROM changelog'));
	const truncated = filesRows.length > MAX_MANIFEST_FILES;
	const rows = truncated ? filesRows.slice(0, MAX_MANIFEST_FILES) : filesRows;
	const files: Record<string, { hash: string; size: number; modified: string }> = {};
	for (const row of rows) {
		files[row.path] = { hash: row.hash, size: row.size, modified: row.modified };
	}
	const lastSeq = seqRows[0]?.lastSeq || 0;

	return corsResponse({ version: 1, files, lastSeq, ...(truncated && { truncated: true }) });
}

export async function handleGetConfig(env: Env): Promise<Response> {
	return corsResponse({
		accountId: env.CF_ACCOUNT_ID || null,
		workerName: env.CF_WORKER_NAME || null,
		bucketName: env.CF_BUCKET_NAME || null,
		databaseId: env.CF_DATABASE_ID || null,
	});
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
