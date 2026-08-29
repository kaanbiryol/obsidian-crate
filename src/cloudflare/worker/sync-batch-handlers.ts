import { sha256HexBytes } from './auth';
import { corsResponse } from './cors';
import { commitFileDelete, commitStagedFile } from './sync-mutations';
import {
	isSha256Hex,
	parseJsonObject,
	parseNonNegativeInteger,
	parseOptionalString,
	sanitizePath,
} from './utils';
import {
	createManagedObjectKey,
	deleteBucketObjectsQuietly,
	formatMetadataCommitFailure,
	formatMutationError,
	loadStoredFileRows,
	MAX_BATCH_FILES,
	MAX_BATCH_DOWNLOAD_BYTES,
	MAX_BATCH_TOTAL_BYTES,
	parseExpectedFileHash,
	resolveStoredObjectKey,
	storedObjectMatchesMetadata,
	type ExpectedFileHash,
	type FileStorageRow,
} from './sync-storage';

interface BatchFile {
	path: string;
	content: string;
	hash?: string;
	size?: number;
	contentType?: string;
	expectedHash?: unknown;
}

interface BatchDeleteFile {
	path?: unknown;
	expectedHash?: unknown;
}

export async function handleBatchUpload(request: Request, bucket: R2Bucket, db: D1Database): Promise<Response> {
	const parsedBody = await parseJsonObject(request, 15 * 1024 * 1024);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const files = parsedBody.value.files;
	if (!Array.isArray(files) || files.length === 0) return corsResponse({ error: 'files array required' }, 400);
	if (files.length > MAX_BATCH_FILES) return corsResponse({ error: `Maximum ${MAX_BATCH_FILES} files per batch` }, 400);

	const results: Array<{ path: string; success: boolean; hash?: string; error?: string }> = [];
	const uploads: Array<{
		safePath: string;
		bytes: ArrayBuffer;
		hash: string;
		size: number;
		contentType: string;
		objectKey: string;
		expectedHash: ExpectedFileHash;
	}> = [];
	let totalBytes = 0;
	const seenPaths = new Set<string>();

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
		if (seenPaths.has(safePath)) {
			results.push({ path: safePath, success: false, error: 'Duplicate path in batch' });
			continue;
		}
		seenPaths.add(safePath);

		const expectedHash = parseExpectedFileHash(file.expectedHash);
		if (expectedHash === undefined) {
			results.push({ path: safePath, success: false, error: 'Valid expectedHash required' });
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
				objectKey: createManagedObjectKey(providedHash || computedHash),
				expectedHash: expectedHash ?? null,
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			results.push({ path: safePath, success: false, error: message });
		}
	}

	let previousFiles = new Map<string, FileStorageRow>();
	if (uploads.length > 0) {
		try {
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

	let metadataFailure = false;
	await Promise.all(uploads.map(async (file) => {
		try {
			await bucket.put(file.objectKey, file.bytes, {
				httpMetadata: { contentType: file.contentType },
				customMetadata: { hash: file.hash },
			});
			const commit = await commitStagedFile(bucket, db, {
				path: file.safePath,
				hash: file.hash,
				size: file.size,
				objectKey: file.objectKey,
				expectedHash: file.expectedHash,
				previousFile: previousFiles.get(file.safePath) ?? null,
			});
			if (!commit.committed) {
				results.push({
					path: file.safePath,
					success: false,
					error: `Remote file changed since it was read${commit.currentHash ? ` (current hash: ${commit.currentHash})` : ''}`,
				});
				return;
			}

			results.push({ path: file.safePath, success: true, hash: file.hash });
		} catch (err: unknown) {
			metadataFailure = true;
			await deleteBucketObjectsQuietly(bucket, [file.objectKey]);
			const message = formatMetadataCommitFailure('Upload', formatMutationError(err));
			results.push({ path: file.safePath, success: false, error: message });
		}
	}));

	return corsResponse({ success: results.every(r => r.success), results }, metadataFailure ? 503 : 200);
}

export async function handleBatchDownload(request: Request, bucket: R2Bucket, db: D1Database): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}
	const rawPaths = parsedBody.value.paths;
	if (!Array.isArray(rawPaths) || rawPaths.length === 0 || rawPaths.length > MAX_BATCH_FILES) {
		return corsResponse({ error: `paths array required (maximum ${MAX_BATCH_FILES})` }, 400);
	}
	if (!rawPaths.every((path) => typeof path === 'string' && path.length <= 4096)) {
		return corsResponse({ error: 'Invalid path in batch' }, 400);
	}
	const paths = rawPaths as string[];
	if (new Set(paths).size !== paths.length) {
		return corsResponse({ error: 'Duplicate paths are not allowed' }, 400);
	}

	let storedFiles = new Map<string, FileStorageRow>();
	try {
		storedFiles = await loadStoredFileRows(db, paths);
		const declaredTotal = Array.from(storedFiles.values())
			.reduce((total, file) => total + file.size, 0);
		if (declaredTotal > MAX_BATCH_DOWNLOAD_BYTES) {
			return corsResponse({ error: 'Batch download exceeds 8MB limit; download files individually' }, 413);
		}
	} catch {
		return corsResponse({ error: 'Sync metadata unavailable' }, 503);
	}

	const files: Array<{ path: string; content: string; hash: string; size: number; contentType: string; error?: string }> = [];
	let totalBytes = 0;
	for (const rawPath of paths) {
		const safePath = sanitizePath(rawPath);
		if (!safePath) {
			files.push({ path: rawPath, content: '', hash: '', size: 0, contentType: '', error: 'Invalid path' });
			continue;
		}

		try {
			const storedFile = storedFiles.get(safePath) ?? null;
			const objectKey = storedFile
				? resolveStoredObjectKey(safePath, storedFile.storageKey)
				: null;
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
					error: 'File content unavailable',
				});
				continue;
			}
			if (storedFile && !storedObjectMatchesMetadata(obj, storedFile)) {
				files.push({
					path: safePath,
					content: '',
					hash: storedFile.hash,
					size: storedFile.size,
					contentType: '',
					error: 'File content failed integrity validation',
				});
				continue;
			}

			totalBytes += obj.size;
			if (totalBytes > MAX_BATCH_DOWNLOAD_BYTES) {
				return corsResponse({ error: 'Batch download exceeds 8MB limit; download files individually' }, 413);
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
				hash: storedFile?.hash || obj.customMetadata?.hash || '',
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

export async function handleBatchDelete(request: Request, bucket: R2Bucket, db: D1Database): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}
	const rawFiles = parsedBody.value.files;
	if (!Array.isArray(rawFiles) || rawFiles.length === 0 || rawFiles.length > MAX_BATCH_FILES) {
		return corsResponse({ error: `files array required (maximum ${MAX_BATCH_FILES})` }, 400);
	}

	const deleted: string[] = [];
	const errors: Array<{ path: string; error: string; status?: number; currentHash?: string | null }> = [];
	const validFiles: Array<{ path: string; expectedHash: string }> = [];
	const seenPaths = new Set<string>();

	for (const rawFile of rawFiles as BatchDeleteFile[]) {
		const rawPath = typeof rawFile?.path === 'string' ? rawFile.path : '';
		const safePath = sanitizePath(rawPath);
		if (!safePath) {
			errors.push({ path: rawPath, error: 'Invalid path' });
			continue;
		}
		if (seenPaths.has(safePath)) {
			errors.push({ path: safePath, error: 'Duplicate path in batch' });
			continue;
		}
		seenPaths.add(safePath);
		const expectedHash = parseExpectedFileHash(rawFile.expectedHash);
		if (expectedHash === undefined || expectedHash === null) {
			errors.push({ path: safePath, error: 'Valid expectedHash required' });
			continue;
		}

		validFiles.push({ path: safePath, expectedHash });
	}

	let previousFiles = new Map<string, FileStorageRow>();
	if (validFiles.length > 0) {
		try {
			previousFiles = await loadStoredFileRows(db, validFiles.map((file) => file.path));
		} catch (error: unknown) {
			return corsResponse({
				success: false,
				deleted: [],
				errors: errors.concat(validFiles.map((file) => ({
					path: file.path,
					error: formatMetadataCommitFailure('Delete', formatMutationError(error)),
				}))),
			}, 503);
		}
	}

	let metadataFailure = false;
	for (const file of validFiles) {
		try {
			const commit = await commitFileDelete(bucket, db, {
				path: file.path,
				expectedHash: file.expectedHash,
				previousFile: previousFiles.get(file.path) ?? null,
			});
			if (!commit.committed) {
				errors.push({
					path: file.path,
					error: 'Remote file changed since it was read',
					status: 409,
					currentHash: commit.currentHash,
				});
				continue;
			}
			deleted.push(file.path);
		} catch (error: unknown) {
			metadataFailure = true;
			errors.push({
				path: file.path,
				error: formatMetadataCommitFailure('Delete', formatMutationError(error)),
			});
		}
	}

	return corsResponse({
		success: errors.length === 0,
		deleted,
		...(errors.length > 0 ? { errors } : {}),
	}, metadataFailure ? 503 : 200);
}
