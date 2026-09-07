import { sha256HexBytes } from '../auth';
import { corsResponse } from '../cors';
import { commitStagedFile } from '../sync-mutations';
import { FileNamespaceConflictError } from '../file-namespace';
import {
	isSha256Hex,
	parseJsonObject,
	parseNonNegativeInteger,
	parseOptionalString,
	sanitizePath,
} from '../utils';
import {
	createManagedObjectKey,
	formatMetadataCommitFailure,
	formatMutationError,
	loadStoredFileRows,
	MAX_BATCH_UPLOAD_FILES,
	MAX_BATCH_TOTAL_BYTES,
	parseExpectedFileHash,
	type ExpectedFileHash,
	type FileStorageRow,
} from '../sync-storage';
import type { BatchFile } from './types';
import type { BatchUploadResponse } from '../../../protocol/sync-types';

export async function handleBatchUpload(
	request: Request,
	bucket: R2Bucket,
	db: D1Database,
): Promise<Response> {
	const parsedBody = await parseJsonObject(request, 15 * 1024 * 1024);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const files = parsedBody.value.files;
	if (!Array.isArray(files) || files.length === 0) {
		return corsResponse({ error: 'files array required' }, 400);
	}
	if (files.length > MAX_BATCH_UPLOAD_FILES) {
		return corsResponse({ error: `Maximum ${MAX_BATCH_UPLOAD_FILES} files per batch` }, 400);
	}

	const results: BatchUploadResponse['results'] = [];
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
			results.push(validationFailure(
				typeof file?.path === 'string' ? file.path : '',
				'Invalid file payload',
			));
			continue;
		}

		const safePath = sanitizePath(file.path);
		if (!safePath) {
			results.push(validationFailure(file.path, 'Invalid path'));
			continue;
		}
		if (seenPaths.has(safePath)) {
			results.push(validationFailure(safePath, 'Duplicate path in batch'));
			continue;
		}
		seenPaths.add(safePath);

		const expectedHash = parseExpectedFileHash(file.expectedHash);
		if (expectedHash === undefined) {
			results.push(validationFailure(safePath, 'Valid expectedHash required'));
			continue;
		}

		try {
			const raw = atob(file.content);
			const bytes = new Uint8Array(raw.length);
			for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
			const size = bytes.byteLength;
			if (file.size !== undefined && parseNonNegativeInteger(file.size) === null) {
				results.push(validationFailure(safePath, 'Invalid declared file size'));
				continue;
			}
			if (typeof file.size === 'number' && file.size !== size) {
				results.push(validationFailure(safePath, 'Declared file size does not match content'));
				continue;
			}

			if (file.hash !== undefined && typeof file.hash !== 'string') {
				results.push(validationFailure(safePath, 'Invalid file hash'));
				continue;
			}
			const providedHash = file.hash?.trim().toLowerCase() || '';
			if (providedHash && !isSha256Hex(providedHash)) {
				results.push(validationFailure(safePath, 'Invalid file hash'));
				continue;
			}

			if (file.contentType !== undefined && typeof file.contentType !== 'string') {
				results.push(validationFailure(safePath, 'Invalid content type'));
				continue;
			}

			const computedHash = await sha256HexBytes(bytes);
			if (providedHash && providedHash !== computedHash) {
				results.push(validationFailure(safePath, 'Declared file hash does not match content'));
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
		} catch (error: unknown) {
			results.push(validationFailure(safePath, formatMutationError(error)));
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
					code: 'storage' as const,
					status: 503,
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
				content: file.bytes,
				expectedHash: file.expectedHash,
				previousFile: previousFiles.get(file.safePath) ?? null,
			});
			if (!commit.committed) {
				results.push({
					path: file.safePath,
					success: false,
					error: `Remote file changed since it was read${commit.currentHash ? ` (current hash: ${commit.currentHash})` : ''}`,
					code: 'version_conflict',
					status: 409,
					currentHash: commit.currentHash,
				});
				return;
			}

			results.push({ path: file.safePath, success: true, hash: file.hash, revision: commit.revision });
		} catch (error: unknown) {
			if (error instanceof FileNamespaceConflictError) {
				results.push({ path: file.safePath, success: false, error: error.message, code: error.code, status: 409 });
				return;
			}
			metadataFailure = true;
			// An uncertain commit does not establish that this object is unused.
			results.push({
				path: file.safePath,
				success: false,
				error: formatMetadataCommitFailure('Upload', formatMutationError(error)),
				code: 'storage',
				status: 503,
			});
		}
	}));

	return corsResponse({ success: results.every((result) => result.success), results }, metadataFailure ? 503 : 200);
}

function validationFailure(
	path: string,
	error: string,
): BatchUploadResponse['results'][number] {
	return { path, success: false, error, code: 'validation', status: 400 };
}
