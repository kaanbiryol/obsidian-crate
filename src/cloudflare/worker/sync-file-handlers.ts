import { sha256HexBytes } from './auth';
import { corsHeaders, corsResponse } from './cors';
import { maybePruneChangelog } from './db';
import { isSha256Hex, parseJsonObject, parseOptionalString, sanitizePath } from './utils';
import {
	collectCleanupKeys,
	createManagedObjectKey,
	deleteBucketObjectsQuietly,
	ensureSyncMetadata,
	formatMetadataCommitFailure,
	formatMutationError,
	getStoredFileRow,
	legacyObjectKey,
	parseDeclaredSize,
	resolveCommittedObjectKey,
	type FileStorageRow,
} from './sync-storage';

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
		let previousFile: FileStorageRow | null = null;
		if (db) {
			try {
				await ensureSyncMetadata(db);
				previousFile = await getStoredFileRow(db, safePath);
			} catch (error: unknown) {
				return corsResponse({
					success: false,
					path: safePath,
					error: formatMetadataCommitFailure('Upload', formatMutationError(error)),
				}, 503);
			}
		}

		const objectKey = db ? createManagedObjectKey(hash) : legacyObjectKey(safePath);
		await bucket.put(objectKey, body, {
			httpMetadata: { contentType },
			customMetadata: { hash },
		});

		if (db) {
			try {
				await db.batch([
					db.prepare('INSERT INTO changelog (path, action, hash, size) VALUES (?, ?, ?, ?)').bind(safePath, 'put', hash || '', size || 0),
					db.prepare("INSERT OR REPLACE INTO files (path, hash, size, modified, storage_key) VALUES (?, ?, ?, datetime('now'), ?)").bind(safePath, hash || '', size || 0, objectKey),
				]);
				await maybePruneChangelog(db);
			} catch (error: unknown) {
				await deleteBucketObjectsQuietly(bucket, [objectKey]);
				return corsResponse({
					success: false,
					path: safePath,
					error: formatMetadataCommitFailure('Upload', formatMutationError(error)),
				}, 503);
			}

			await deleteBucketObjectsQuietly(bucket, collectCleanupKeys(safePath, previousFile, objectKey));
		}

		return corsResponse({ success: true, path: safePath, hash });
	} catch (err: unknown) {
		const message = formatMutationError(err);
		return corsResponse({ success: false, path: safePath, error: message }, 500);
	}
}

export async function handleDownload(request: Request, bucket: R2Bucket, db: D1Database | null): Promise<Response> {
	const url = new URL(request.url);
	const rawPath = url.searchParams.get('path');
	if (!rawPath) return corsResponse({ error: 'Path query parameter required' }, 400);

	const path = sanitizePath(rawPath);
	if (!path) return corsResponse({ error: 'Invalid path' }, 400);

	let objectKey: string | null;
	if (db) {
		try {
			await ensureSyncMetadata(db);
			objectKey = await resolveCommittedObjectKey(db, path);
		} catch {
			return corsResponse({ error: 'Sync metadata unavailable' }, 503);
		}
	} else {
		objectKey = legacyObjectKey(path);
	}

	if (!objectKey) return corsResponse({ error: 'File not found' }, 404);

	const obj = await bucket.get(objectKey);
	if (!obj) {
		return corsResponse({ error: db ? 'File content unavailable' : 'File not found' }, db ? 503 : 404);
	}

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

	let previousFile: FileStorageRow | null = null;
	if (db) {
		try {
			await ensureSyncMetadata(db);
			previousFile = await getStoredFileRow(db, safePath);
			await db.batch([
				db.prepare('INSERT INTO changelog (path, action, hash, size) VALUES (?, ?, ?, ?)').bind(safePath, 'delete', '', 0),
				db.prepare('DELETE FROM files WHERE path = ?').bind(safePath),
			]);
			await maybePruneChangelog(db);
		} catch (error: unknown) {
			return corsResponse({
				success: false,
				path: safePath,
				error: formatMetadataCommitFailure('Delete', formatMutationError(error)),
			}, 503);
		}

		await deleteBucketObjectsQuietly(bucket, collectCleanupKeys(safePath, previousFile));
	} else {
		await bucket.delete(legacyObjectKey(safePath));
	}

	return corsResponse({ success: true, path: safePath });
}
