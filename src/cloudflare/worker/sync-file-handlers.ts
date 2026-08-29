import { sha256HexBytes } from './auth';
import { corsHeaders, corsResponse } from './cors';
import { isSha256Hex, parseJsonObject, parseOptionalString, sanitizePath } from './utils';
import { commitFileDelete, commitStagedFile } from './sync-mutations';
import {
	createManagedObjectKey,
	deleteBucketObjectsQuietly,
	ensureSyncMetadata,
	formatMetadataCommitFailure,
	formatMutationError,
	getStoredFileRow,
	legacyObjectKey,
	MAX_FILE_BYTES,
	parseExpectedFileHash,
	parseDeclaredSize,
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
	const contentLength = parseDeclaredSize(request.headers.get('Content-Length'));
	if (request.headers.has('Content-Length') && contentLength === null) {
		return corsResponse({ error: 'Invalid Content-Length header' }, 400);
	}
	if ((declaredSize ?? 0) > MAX_FILE_BYTES || (contentLength ?? 0) > MAX_FILE_BYTES) {
		return corsResponse({ error: 'File exceeds 25MB limit' }, 413);
	}

	const expectedHash = parseExpectedFileHash(request.headers.get('X-Crate-Expected-Hash'));
	if (db && (!request.headers.has('X-Crate-Expected-Hash') || expectedHash === undefined)) {
		return corsResponse({ error: 'Valid X-Crate-Expected-Hash header required' }, 400);
	}

	const contentType = request.headers.get('Content-Type') || 'application/octet-stream';

	try {
		const body = await request.arrayBuffer();
		const computedSize = body.byteLength;
		if (computedSize > MAX_FILE_BYTES) {
			return corsResponse({ error: 'File exceeds 25MB limit' }, 413);
		}
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
				const commit = await commitStagedFile(bucket, db, {
					path: safePath,
					hash,
					size,
					objectKey,
					expectedHash: expectedHash!,
					previousFile,
				});
				if (!commit.committed) {
					return corsResponse({
						success: false,
						path: safePath,
						error: 'Remote file changed since it was read',
						currentHash: commit.currentHash,
					}, 409);
				}
			} catch (error: unknown) {
				await deleteBucketObjectsQuietly(bucket, [objectKey]);
				return corsResponse({
					success: false,
					path: safePath,
					error: formatMetadataCommitFailure('Upload', formatMutationError(error)),
				}, 503);
			}
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
	let storedFile: FileStorageRow | null = null;
	if (db) {
		try {
			await ensureSyncMetadata(db);
			storedFile = await getStoredFileRow(db, path);
			objectKey = storedFile
				? storedFile.storageKey ?? legacyObjectKey(path)
				: null;
		} catch {
			return corsResponse({ error: 'Sync metadata unavailable' }, 503);
		}
	} else {
		objectKey = legacyObjectKey(path);
	}

	if (!objectKey) return corsResponse({ error: 'File not found' }, 404);
	if (storedFile && storedFile.size > MAX_FILE_BYTES) {
		return corsResponse({ error: 'File exceeds 25MB download limit' }, 413);
	}

	const obj = await bucket.get(objectKey);
	if (!obj) {
		return corsResponse({ error: db ? 'File content unavailable' : 'File not found' }, db ? 503 : 404);
	}
	if (storedFile && (
		(storedFile.size > 0 && obj.size !== storedFile.size)
		|| (obj.customMetadata?.hash && obj.customMetadata.hash !== storedFile.hash)
	)) {
		return corsResponse({ error: 'File content failed integrity validation' }, 503);
	}
	if (obj.size > MAX_FILE_BYTES) {
		return corsResponse({ error: 'File exceeds 25MB download limit' }, 413);
	}

	return new Response(obj.body, {
		status: 200,
		headers: {
			'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
			'Content-Length': String(obj.size),
			'X-File-Hash': storedFile?.hash || obj.customMetadata?.hash || '',
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
	const expectedHash = parseExpectedFileHash(parsedBody.value.expectedHash);
	if (db && (expectedHash === undefined || expectedHash === null)) {
		return corsResponse({ error: 'Valid expectedHash required' }, 400);
	}

	let previousFile: FileStorageRow | null = null;
	if (db) {
		try {
			await ensureSyncMetadata(db);
			previousFile = await getStoredFileRow(db, safePath);
			const commit = await commitFileDelete(bucket, db, {
				path: safePath,
				expectedHash: expectedHash!,
				previousFile,
			});
			if (!commit.committed) {
				return corsResponse({
					success: false,
					path: safePath,
					error: 'Remote file changed since it was read',
					currentHash: commit.currentHash,
				}, 409);
			}
		} catch (error: unknown) {
			return corsResponse({
				success: false,
				path: safePath,
				error: formatMetadataCommitFailure('Delete', formatMutationError(error)),
			}, 503);
		}
	} else {
		await bucket.delete(legacyObjectKey(safePath));
	}

	return corsResponse({ success: true, path: safePath });
}
