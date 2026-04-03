import { corsResponse } from './cors';
import { sha256HexBytes } from './auth';
import { initDb, maybePruneChangelog, queryRows } from './db';
import {
	sanitizePath,
	FILES_PREFIX,
	isSha256Hex,
	parseJsonObject,
	parseNonNegativeInteger,
	parseOptionalString,
	parseStringArray,
} from './utils';
import type { Env } from './types';
import { normalizeSharedSettingsValue } from '../../sync/shared-settings';

const MAX_BATCH_FILES = 50;
const MAX_BATCH_TOTAL_BYTES = 10 * 1024 * 1024;

type BucketObjectSnapshot =
	| { exists: false }
	| {
		exists: true;
		body: ArrayBuffer;
		httpMetadata?: R2HttpMetadata;
		customMetadata?: Record<string, string>;
	};

function parseDeclaredSize(headerValue: string | null): number | null {
	if (headerValue === null) {
		return null;
	}

	const size = Number.parseInt(headerValue, 10);
	return Number.isInteger(size) && size >= 0 ? size : null;
}

function formatMutationError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function snapshotBucketObject(bucket: R2Bucket, key: string): Promise<BucketObjectSnapshot> {
	const object = await bucket.get(key);
	if (!object) {
		return { exists: false };
	}

	return {
		exists: true,
		body: await object.arrayBuffer(),
		httpMetadata: object.httpMetadata ? { ...object.httpMetadata } : undefined,
		customMetadata: object.customMetadata ? { ...object.customMetadata } : undefined,
	};
}

async function restoreBucketObject(bucket: R2Bucket, key: string, snapshot: BucketObjectSnapshot): Promise<void> {
	if (!snapshot.exists) {
		await bucket.delete(key);
		return;
	}

	await bucket.put(key, snapshot.body, {
		httpMetadata: snapshot.httpMetadata ? { ...snapshot.httpMetadata } : undefined,
		customMetadata: snapshot.customMetadata ? { ...snapshot.customMetadata } : undefined,
	});
}

async function rollbackMutationOnMetadataFailure(params: {
	actionLabel: 'Upload' | 'Delete';
	path: string;
	bucket: R2Bucket;
	objectKey: string;
	snapshot: BucketObjectSnapshot;
	commitMetadata: () => Promise<void>;
}): Promise<Response | null> {
	try {
		await params.commitMetadata();
		return null;
	} catch (metadataError: unknown) {
		const metadataMessage = formatMutationError(metadataError);
		try {
			await restoreBucketObject(params.bucket, params.objectKey, params.snapshot);
			return corsResponse({
				success: false,
				path: params.path,
				error: `${params.actionLabel} rolled back because sync metadata update failed: ${metadataMessage}`,
			}, 503);
		} catch (rollbackError: unknown) {
			return corsResponse({
				success: false,
				path: params.path,
				error: `${params.actionLabel} metadata update failed and rollback failed: ${metadataMessage}; ${formatMutationError(rollbackError)}`,
			}, 500);
		}
	}
}

export async function handleHealth(): Promise<Response> {
	return corsResponse({ status: 'ok', timestamp: new Date().toISOString() });
}

export async function handleCheckChanges(request: Request, db: D1Database): Promise<Response> {
	await initDb(db);
	const url = new URL(request.url);
	const since = parseInt(url.searchParams.get('since') || '0', 10);
	if (isNaN(since) || since < 0) return corsResponse({ error: 'Invalid since parameter' }, 400);
	const maxRows = await queryRows<{ lastSeq: number }>(db.prepare('SELECT MAX(seq) as lastSeq FROM changelog'));
	const minRows = await queryRows<{ minSeq: number | null }>(db.prepare('SELECT MIN(seq) as minSeq FROM changelog'));
	const lastSeq = maxRows[0]?.lastSeq || 0;
	const minSeq = minRows[0]?.minSeq ?? null;
	const cursorExpired = since > 0 && (minSeq === null || since < minSeq);
	return corsResponse({ lastSeq, hasChanges: lastSeq > since, ...(cursorExpired && { cursorExpired: true }) });
}

export async function handleGetChanges(request: Request, db: D1Database): Promise<Response> {
	const url = new URL(request.url);
	const since = parseInt(url.searchParams.get('since') || '0', 10);
	if (isNaN(since) || since < 0) return corsResponse({ error: 'Invalid since parameter' }, 400);

	await initDb(db);
	const changeRows = await queryRows(
		db.prepare('SELECT seq, path, action, hash, size, created_at FROM changelog WHERE seq > ? ORDER BY seq ASC LIMIT 5000').bind(since)
	);
	const maxRows = await queryRows<{ lastSeq: number }>(db.prepare('SELECT MAX(seq) as lastSeq FROM changelog'));
	const minRows = await queryRows<{ minSeq: number | null }>(db.prepare('SELECT MIN(seq) as minSeq FROM changelog'));
	const lastSeq = maxRows[0]?.lastSeq || 0;
	const minSeq = minRows[0]?.minSeq ?? null;
	const cursorExpired = since > 0 && (minSeq === null || since < minSeq);

	return corsResponse({
		changes: changeRows,
		lastSeq,
		hasMore: changeRows.length === 5000,
		...(cursorExpired && { cursorExpired: true }),
	});
}

export async function handleGetManifest(request: Request, db: D1Database): Promise<Response> {
	await initDb(db);

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

export async function handleUpload(request: Request, bucket: R2Bucket, db: D1Database | null): Promise<Response> {
	const url = new URL(request.url);
	const rawPath = url.searchParams.get('path');
	if (!rawPath) return corsResponse({ error: 'Path query parameter required' }, 400);

	const safePath = sanitizePath(rawPath);
	if (!safePath) return corsResponse({ error: 'Invalid path' }, 400);

	const hashHeader = request.headers.get('X-File-Hash')?.trim().toLowerCase() || '';
	if (hashHeader && !isSha256Hex(hashHeader)) {
		return corsResponse({ error: 'Invalid X-File-Hash header' }, 400);
	}

	const declaredSize = parseDeclaredSize(request.headers.get('X-File-Size'));
	if (request.headers.has('X-File-Size') && declaredSize === null) {
		return corsResponse({ error: 'Invalid X-File-Size header' }, 400);
	}

	const contentType = request.headers.get('Content-Type') || 'application/octet-stream';

	try {
		const body = await request.arrayBuffer();
		const computedSize = body.byteLength;
		if (declaredSize !== null && declaredSize !== computedSize) {
			return corsResponse({ error: 'File size does not match X-File-Size header' }, 400);
		}

		const computedHash = await sha256HexBytes(body);
		if (hashHeader && hashHeader !== computedHash) {
			return corsResponse({ error: 'File hash does not match X-File-Hash header' }, 400);
		}

		const hash = hashHeader || computedHash;
		const size = declaredSize ?? computedSize;
		const objectKey = FILES_PREFIX + safePath;
		const previousObject = db ? await snapshotBucketObject(bucket, objectKey) : null;
		await bucket.put(objectKey, body, {
			httpMetadata: { contentType },
			customMetadata: { hash },
		});

		if (db && previousObject) {
			const rollbackResponse = await rollbackMutationOnMetadataFailure({
				actionLabel: 'Upload',
				path: safePath,
				bucket,
				objectKey,
				snapshot: previousObject,
				commitMetadata: async () => {
					await initDb(db);
					await db.batch([
						db.prepare('INSERT INTO changelog (path, action, hash, size) VALUES (?, ?, ?, ?)').bind(safePath, 'put', hash || '', size || 0),
						db.prepare("INSERT OR REPLACE INTO files (path, hash, size, modified) VALUES (?, ?, ?, datetime('now'))").bind(safePath, hash || '', size || 0),
					]);
					await maybePruneChangelog(db);
				},
			});
			if (rollbackResponse) {
				return rollbackResponse;
			}
		}

		return corsResponse({ success: true, path: safePath, hash });
	} catch (err: unknown) {
		const message = formatMutationError(err);
		return corsResponse({ success: false, path: safePath, error: message }, 500);
	}
}

export async function handleDownload(request: Request, bucket: R2Bucket): Promise<Response> {
	const url = new URL(request.url);
	const rawPath = url.searchParams.get('path');
	if (!rawPath) return corsResponse({ error: 'Path query parameter required' }, 400);

	const path = sanitizePath(rawPath);
	if (!path) return corsResponse({ error: 'Invalid path' }, 400);

	const obj = await bucket.get(FILES_PREFIX + path);
	if (!obj) return corsResponse({ error: 'File not found' }, 404);

	const { corsHeaders } = await import('./cors');
	return new Response(obj.body, {
		status: 200,
		headers: {
			'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
			'Content-Length': String(obj.size),
			'X-File-Hash': obj.customMetadata?.hash || '',
			...corsHeaders(),
		},
	});
}

export async function handleDelete(request: Request, bucket: R2Bucket, db: D1Database | null): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const rawPath = parseOptionalString(parsedBody.value.path, 1024);
	if (!rawPath) return corsResponse({ error: 'Path required' }, 400);

	const safePath = sanitizePath(rawPath);
	if (!safePath) return corsResponse({ error: 'Invalid path' }, 400);

	const objectKey = FILES_PREFIX + safePath;
	const previousObject = db ? await snapshotBucketObject(bucket, objectKey) : null;
	await bucket.delete(objectKey);

	if (db && previousObject) {
		const rollbackResponse = await rollbackMutationOnMetadataFailure({
			actionLabel: 'Delete',
			path: safePath,
			bucket,
			objectKey,
			snapshot: previousObject,
			commitMetadata: async () => {
				await initDb(db);
				await db.batch([
					db.prepare('INSERT INTO changelog (path, action, hash, size) VALUES (?, ?, ?, ?)').bind(safePath, 'delete', '', 0),
					db.prepare('DELETE FROM files WHERE path = ?').bind(safePath),
				]);
				await maybePruneChangelog(db);
			},
		});
		if (rollbackResponse) {
			return rollbackResponse;
		}
	}

	return corsResponse({ success: true, path: safePath });
}

interface BatchFile {
	path: string;
	content: string;
	hash?: string;
	size?: number;
	contentType?: string;
}

export async function handleBatchUpload(request: Request, bucket: R2Bucket, db: D1Database | null): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const files = parsedBody.value.files;
	if (!Array.isArray(files) || files.length === 0) return corsResponse({ error: 'files array required' }, 400);
	if (files.length > MAX_BATCH_FILES) return corsResponse({ error: `Maximum ${MAX_BATCH_FILES} files per batch` }, 400);

	const results: Array<{ path: string; success: boolean; hash?: string; error?: string }> = [];
	const dbOps: D1PreparedStatement[] = [];
	const uploads: Array<{ safePath: string; bytes: ArrayBuffer; hash: string; size: number; contentType: string }> = [];
	let totalBytes = 0;

	for (const file of files as BatchFile[]) {
		if (typeof file?.content !== 'string') {
			results.push({ path: typeof file?.path === 'string' ? file.path : '', success: false, error: 'Invalid file payload' });
			continue;
		}

		const safePath = sanitizePath(file.path);
		if (!safePath) {
			results.push({ path: file.path, success: false, error: 'Invalid path' });
			continue;
		}

		try {
			const raw = atob(file.content);
			const bytes = new Uint8Array(raw.length);
			for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
			const size = bytes.byteLength;
			if (file.size !== undefined && parseNonNegativeInteger(file.size) === null) {
				results.push({ path: safePath, success: false, error: 'Invalid declared file size' });
				continue;
			}
			if (typeof file.size === 'number' && file.size !== size) {
				results.push({ path: safePath, success: false, error: 'Declared file size does not match content' });
				continue;
			}

			if (file.hash !== undefined && typeof file.hash !== 'string') {
				results.push({ path: safePath, success: false, error: 'Invalid file hash' });
				continue;
			}
			const providedHash = file.hash?.trim().toLowerCase() || '';
			if (providedHash && !isSha256Hex(providedHash)) {
				results.push({ path: safePath, success: false, error: 'Invalid file hash' });
				continue;
			}

			if (file.contentType !== undefined && typeof file.contentType !== 'string') {
				results.push({ path: safePath, success: false, error: 'Invalid content type' });
				continue;
			}

			const computedHash = await sha256HexBytes(bytes);
			if (providedHash && providedHash !== computedHash) {
				results.push({ path: safePath, success: false, error: 'Declared file hash does not match content' });
				continue;
			}

			totalBytes += size;
			if (totalBytes > MAX_BATCH_TOTAL_BYTES) {
				return corsResponse({ error: 'Total content exceeds 10MB limit' }, 400);
			}

			uploads.push({
				safePath,
				bytes: bytes.buffer,
				hash: providedHash || computedHash,
				size,
				contentType: parseOptionalString(file.contentType, 255) || 'application/octet-stream',
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			results.push({ path: safePath, success: false, error: message });
		}
	}

	await Promise.all(uploads.map(async (file) => {
		try {
			await bucket.put(FILES_PREFIX + file.safePath, file.bytes, {
				httpMetadata: { contentType: file.contentType },
				customMetadata: { hash: file.hash },
			});

			results.push({ path: file.safePath, success: true, hash: file.hash });

			if (db) {
				dbOps.push(
					db.prepare('INSERT INTO changelog (path, action, hash, size) VALUES (?, ?, ?, ?)').bind(file.safePath, 'put', file.hash, file.size),
					db.prepare("INSERT OR REPLACE INTO files (path, hash, size, modified) VALUES (?, ?, ?, datetime('now'))").bind(file.safePath, file.hash, file.size),
				);
			}
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			results.push({ path: file.safePath, success: false, error: message });
		}
	}));

	if (db && dbOps.length > 0) {
		try {
			await initDb(db);
			await db.batch(dbOps);
			await maybePruneChangelog(db);
		} catch { /* D1 failure is non-fatal */ }
	}

	return corsResponse({ success: results.every(r => r.success), results });
}

export async function handleBatchDownload(request: Request, bucket: R2Bucket): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}
	const paths = parseStringArray(parsedBody.value.paths, MAX_BATCH_FILES, 4096);
	if (!paths || paths.length === 0) return corsResponse({ error: 'paths array required' }, 400);

	const files: Array<{ path: string; content: string; hash: string; size: number; contentType: string; error?: string }> = [];
	for (const rawPath of paths) {
		const safePath = sanitizePath(rawPath);
		if (!safePath) {
			files.push({ path: rawPath, content: '', hash: '', size: 0, contentType: '', error: 'Invalid path' });
			continue;
		}

		try {
			const obj = await bucket.get(FILES_PREFIX + safePath);
			if (!obj) {
				files.push({ path: safePath, content: '', hash: '', size: 0, contentType: '', error: 'File not found' });
				continue;
			}

			const arrayBuffer = await obj.arrayBuffer();
			const bytes = new Uint8Array(arrayBuffer);
			const chunkSize = 8192;
			let binary = '';
			for (let i = 0; i < bytes.length; i += chunkSize) {
				const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
				binary += String.fromCharCode(...chunk);
			}
			const b64 = btoa(binary);

			files.push({
				path: safePath,
				content: b64,
				hash: obj.customMetadata?.hash || '',
				size: obj.size,
				contentType: obj.httpMetadata?.contentType || 'application/octet-stream',
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			files.push({ path: safePath, content: '', hash: '', size: 0, contentType: '', error: message });
		}
	}

	return corsResponse({ files });
}

export async function handleBatchDelete(request: Request, bucket: R2Bucket, db: D1Database | null): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}
	const paths = parseStringArray(parsedBody.value.paths, MAX_BATCH_FILES, 4096);
	if (!paths || paths.length === 0) return corsResponse({ error: 'paths array required' }, 400);

	const deleted: string[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	const dbOps: D1PreparedStatement[] = [];

	for (const rawPath of paths) {
		const safePath = sanitizePath(rawPath);
		if (!safePath) {
			errors.push({ path: rawPath, error: 'Invalid path' });
			continue;
		}

		try {
			await bucket.delete(FILES_PREFIX + safePath);
			deleted.push(safePath);

			if (db) {
				dbOps.push(
					db.prepare('INSERT INTO changelog (path, action, hash, size) VALUES (?, ?, ?, ?)').bind(safePath, 'delete', '', 0),
					db.prepare('DELETE FROM files WHERE path = ?').bind(safePath),
				);
			}
		} catch (error: unknown) {
			errors.push({
				path: safePath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (db && dbOps.length > 0) {
		try {
			await initDb(db);
			await db.batch(dbOps);
			await maybePruneChangelog(db);
		} catch { /* D1 failure is non-fatal */ }
	}

	return corsResponse({
		success: errors.length === 0,
		deleted,
		...(errors.length > 0 ? { errors } : {}),
	});
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
