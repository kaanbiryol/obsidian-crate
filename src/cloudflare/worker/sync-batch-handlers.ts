import { sha256HexBytes } from './auth';
import { corsResponse } from './cors';
import { maybePruneChangelog } from './db';
import {
	isSha256Hex,
	parseJsonObject,
	parseNonNegativeInteger,
	parseOptionalString,
	parseStringArray,
	sanitizePath,
} from './utils';
import {
	collectCleanupKeys,
	createManagedObjectKey,
	deleteBucketObjectsQuietly,
	ensureSyncMetadata,
	formatMetadataCommitFailure,
	formatMutationError,
	legacyObjectKey,
	loadStoredFileRows,
	resolveCommittedObjectKey,
	MAX_BATCH_FILES,
	MAX_BATCH_TOTAL_BYTES,
	type FileStorageRow,
} from './sync-storage';

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
	const uploads: Array<{ safePath: string; bytes: ArrayBuffer; hash: string; size: number; contentType: string; objectKey: string }> = [];
	const committedUploads: Array<{ safePath: string; hash: string; objectKey: string }> = [];
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
				objectKey: db ? createManagedObjectKey(providedHash || computedHash) : legacyObjectKey(safePath),
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			results.push({ path: safePath, success: false, error: message });
		}
	}

	let previousFiles = new Map<string, FileStorageRow>();
	if (db && uploads.length > 0) {
		try {
			await ensureSyncMetadata(db);
			previousFiles = await loadStoredFileRows(db, uploads.map((file) => file.safePath));
		} catch (error: unknown) {
			return corsResponse({
				success: false,
				results: results.concat(uploads.map((file) => ({
					path: file.safePath,
					success: false as const,
					error: formatMetadataCommitFailure('Upload', formatMutationError(error)),
				}))),
			}, 503);
		}
	}

	await Promise.all(uploads.map(async (file) => {
		try {
			await bucket.put(file.objectKey, file.bytes, {
				httpMetadata: { contentType: file.contentType },
				customMetadata: { hash: file.hash },
			});

			results.push({ path: file.safePath, success: true, hash: file.hash });
			committedUploads.push({ safePath: file.safePath, hash: file.hash, objectKey: file.objectKey });

			if (db) {
				dbOps.push(
					db.prepare('INSERT INTO changelog (path, action, hash, size) VALUES (?, ?, ?, ?)').bind(file.safePath, 'put', file.hash, file.size),
					db.prepare("INSERT OR REPLACE INTO files (path, hash, size, modified, storage_key) VALUES (?, ?, ?, datetime('now'), ?)").bind(file.safePath, file.hash, file.size, file.objectKey),
				);
			}
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			results.push({ path: file.safePath, success: false, error: message });
		}
	}));

	if (db && dbOps.length > 0) {
		try {
			await db.batch(dbOps);
			await maybePruneChangelog(db);
		} catch (error: unknown) {
			const metadataMessage = formatMutationError(error);
			await deleteBucketObjectsQuietly(bucket, committedUploads.map((upload) => upload.objectKey));
			const failedPaths = new Set(committedUploads.map((upload) => upload.safePath));
			const finalResults = results
				.filter((result) => !failedPaths.has(result.path))
				.concat(committedUploads.map((upload) => {
					return {
						path: upload.safePath,
						success: false as const,
						error: formatMetadataCommitFailure('Upload', metadataMessage),
					};
				}));

			return corsResponse({ success: false, results: finalResults }, 503);
		}

		await deleteBucketObjectsQuietly(
			bucket,
			committedUploads.flatMap((upload) => collectCleanupKeys(upload.safePath, previousFiles.get(upload.safePath) ?? null, upload.objectKey)),
		);
	}

	return corsResponse({ success: results.every(r => r.success), results });
}

export async function handleBatchDownload(request: Request, bucket: R2Bucket, db: D1Database | null): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}
	const paths = parseStringArray(parsedBody.value.paths, MAX_BATCH_FILES, 4096);
	if (!paths || paths.length === 0) return corsResponse({ error: 'paths array required' }, 400);

	if (db) {
		try {
			await ensureSyncMetadata(db);
		} catch {
			return corsResponse({ error: 'Sync metadata unavailable' }, 503);
		}
	}

	const files: Array<{ path: string; content: string; hash: string; size: number; contentType: string; error?: string }> = [];
	for (const rawPath of paths) {
		const safePath = sanitizePath(rawPath);
		if (!safePath) {
			files.push({ path: rawPath, content: '', hash: '', size: 0, contentType: '', error: 'Invalid path' });
			continue;
		}

		try {
			const objectKey = db
				? await resolveCommittedObjectKey(db, safePath)
				: legacyObjectKey(safePath);
			if (!objectKey) {
				files.push({ path: safePath, content: '', hash: '', size: 0, contentType: '', error: 'File not found' });
				continue;
			}

			const obj = await bucket.get(objectKey);
			if (!obj) {
				files.push({
					path: safePath,
					content: '',
					hash: '',
					size: 0,
					contentType: '',
					error: db ? 'File content unavailable' : 'File not found',
				});
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
	const validPaths: string[] = [];

	for (const rawPath of paths) {
		const safePath = sanitizePath(rawPath);
		if (!safePath) {
			errors.push({ path: rawPath, error: 'Invalid path' });
			continue;
		}

		validPaths.push(safePath);
	}

	let previousFiles = new Map<string, FileStorageRow>();
	if (db && validPaths.length > 0) {
		try {
			await ensureSyncMetadata(db);
			previousFiles = await loadStoredFileRows(db, validPaths);
		} catch (error: unknown) {
			return corsResponse({
				success: false,
				deleted: [],
				errors: errors.concat(validPaths.map((path) => ({
					path,
					error: formatMetadataCommitFailure('Delete', formatMutationError(error)),
				}))),
			}, 503);
		}
	}

	for (const safePath of validPaths) {
		try {
			if (db) {
				dbOps.push(
					db.prepare('INSERT INTO changelog (path, action, hash, size) VALUES (?, ?, ?, ?)').bind(safePath, 'delete', '', 0),
					db.prepare('DELETE FROM files WHERE path = ?').bind(safePath),
				);
				deleted.push(safePath);
				continue;
			}

			await bucket.delete(legacyObjectKey(safePath));
			deleted.push(safePath);
		} catch (error: unknown) {
			errors.push({
				path: safePath,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (db && dbOps.length > 0) {
		try {
			await db.batch(dbOps);
			await maybePruneChangelog(db);
		} catch (error: unknown) {
			const metadataMessage = formatMutationError(error);
			const metadataErrors = deleted.map((path) => {
				return {
					path,
					error: formatMetadataCommitFailure('Delete', metadataMessage),
				};
			});
			return corsResponse({
				success: false,
				deleted: [],
				errors: errors.concat(metadataErrors),
			}, 503);
		}

		await deleteBucketObjectsQuietly(
			bucket,
			deleted.flatMap((path) => collectCleanupKeys(path, previousFiles.get(path) ?? null)),
		);
	}

	return corsResponse({
		success: errors.length === 0,
		deleted,
		...(errors.length > 0 ? { errors } : {}),
	});
}
