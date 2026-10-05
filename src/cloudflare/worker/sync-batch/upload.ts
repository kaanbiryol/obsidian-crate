import { commitNewFiles } from '../bulk-new-file-commit';
import type { EncryptionServerState } from '../../../encryption/server-state';
import { ENCRYPTED_FILE_CONTENT_TYPE } from '../../../encryption/file-format';
import { trackStagedUploads } from '../staged-uploads';
import { trackStagedBatch } from '../staged-upload-batches';
import { beginUploadOperation } from '../upload-operations';
import { corsResponse } from '../cors';
import { commitStagedFile } from '../sync-mutations';
import { FileNamespaceConflictError } from '../file-namespace';
import { EncryptionStateError, validateUploadEncryption } from '../encryption-state';
import {
	formatMetadataCommitFailure,
	formatMutationError,
	loadStoredFileRows,
	type FileStorageRow,
} from '../sync-storage';
import { prepareBatchUpload, validationFailure } from './upload-validation';
import type { BatchUploadResponse } from '../../../protocol/sync-types';

export async function handleBatchUpload(
	request: Request,
	bucket: R2Bucket,
	db: D1Database,
  commitUpload = commitStagedFile,
  commitBulk = commitNewFiles,
  expectedEncryption?: EncryptionServerState | null,
  resetGeneration?: string | null,
): Promise<Response> {
	const prepared = await prepareBatchUpload(request, expectedEncryption);
	if (prepared instanceof Response) return prepared;
	const { bulkNew, candidates, results } = prepared;

	// Receipt checks are independent; do not pay their latency once per file.
	const checked = await Promise.all(candidates.map(async file => {
		try {
			const operation = await beginUploadOperation(db, file.operationId, {
				path: file.safePath, hash: file.hash, size: file.size,
				contentType: file.contentType, expectedHash: file.expectedHash,
			});
			if (operation instanceof Response) {
				const receipt = await operation.json() as BatchUploadResponse['results'][number];
				results.push({ ...receipt, path: file.safePath, ...(!receipt.success ? { status: operation.status } : {}) });
				return null;
			}
			return { ...file, operation };
		} catch (error) {
			results.push(validationFailure(file.safePath, formatMutationError(error)));
			return null;
		}
	}));
	const uploads = checked.filter((file): file is NonNullable<typeof file> => file !== null);

	let previousFiles = new Map<string, FileStorageRow>();
	if (!bulkNew && uploads.length > 0) {
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

	let stagingBatchId: string | undefined;
	let encryptionState: EncryptionServerState | null = null;
	try {
		const validatedEncryption = await validateUploadEncryption(db, uploads.map(file => ({ path: file.safePath, content: file.bytes, contentType: file.contentType })), expectedEncryption);
		if (bulkNew) stagingBatchId = await trackStagedBatch(db, uploads.map(file => ({ storageKey: file.objectKey, path: file.safePath })), resetGeneration);
		else encryptionState = await trackStagedUploads(db, uploads.map(file => ({ storageKey: file.objectKey, path: file.safePath })), uploads.every(file => file.contentType === ENCRYPTED_FILE_CONTENT_TYPE), validatedEncryption, resetGeneration);
	} catch (error) {
		if (error instanceof EncryptionStateError) return corsResponse({ error: error.message, code: 'encryption_required' }, error.status);
		return corsResponse({ success: false, results: results.concat(uploads.map(file => ({
			path: file.safePath, success: false as const, code: 'storage' as const, status: 503,
			error: formatMetadataCommitFailure('Upload', formatMutationError(error)),
		}))) }, 503);
	}
	if (bulkNew) {
		const staged: typeof uploads = [];
		let failed = false;
		// Bound open R2 connections and retained request data on the Worker.
		for (let offset = 0; offset < uploads.length; offset += 3) {
			await Promise.all(uploads.slice(offset, offset + 3).map(async file => {
				try {
					await bucket.put(file.objectKey, file.bytes, {
						httpMetadata: { contentType: file.contentType }, customMetadata: { hash: file.hash },
					});
					staged.push(file);
				} catch (error) {
					failed = true;
					results.push({ path: file.safePath, success: false, status: 503, code: 'storage', error: formatMutationError(error) });
				}
			}));
		}
		try {
			results.push(...await commitBulk(bucket, db, staged.map(file => ({
				path: file.safePath, hash: file.hash, size: file.size, objectKey: file.objectKey,
				operation: file.operation, content: file.bytes, stagingBatchId, resetGeneration,
			}))));
		} catch (error) {
			failed = true;
			// An uncertain transaction is replayed by operation identity, never cleaned up here.
			results.push(...staged.map(file => ({ path: file.safePath, success: false, status: 503, code: 'storage' as const,
				error: formatMetadataCommitFailure('Upload', formatMutationError(error)) })));
		}
		return corsResponse({ success: results.every(result => result.success), results }, failed ? 503 : 200);
	}

	let metadataFailure = false;
	await Promise.all(uploads.map(async (file) => {
		try {
			await bucket.put(file.objectKey, file.bytes, {
				httpMetadata: { contentType: file.contentType },
				customMetadata: { hash: file.hash },
			});
			const commit = await commitUpload(bucket, db, {
				encryptionState,
				resetGeneration,
				operation: file.operation,
				path: file.safePath,
				hash: file.hash,
				size: file.size,
				objectKey: file.objectKey,
				content: file.bytes,
				expectedHash: file.expectedHash,
				previousFile: previousFiles.get(file.safePath) ?? null,
			});
			if (!commit.committed) {
				if (commit.failure) { results.push(commit.failure); return; }
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
