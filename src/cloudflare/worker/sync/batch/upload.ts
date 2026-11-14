import type { UploadCommitters } from '../staging/upload-committers';
import type { CommitResult } from '../mutations';
import type { EncryptionServerState } from '../../../../encryption/server-state';
import { ENCRYPTED_FILE_CONTENT_TYPE } from '../../../../encryption/file-format';
import { trackUploadLease } from '../staging/upload-leases';
import { beginUploadOperations } from '../upload-operations';
import { corsResponse } from '../../http/cors';
import { FileNamespaceConflictError } from '../file-namespace';
import { descriptorColumn, EncryptionStateError, prepareEncryptedFileCommit, validateUploadEncryption } from '../../encryption/state';
import {
	formatMetadataCommitFailure,
	formatMutationError,
} from '../storage';
import { prepareBatchUpload, validationFailure } from './upload-validation';
import type { BatchUploadResponse } from '../../../../protocol/sync-types';

export async function handleBatchUpload(
	request: Request,
	bucket: R2Bucket,
	db: D1Database,
	committers: UploadCommitters,
	expectedEncryption?: EncryptionServerState | null,
	resetGeneration?: string | null,
): Promise<Response> {
	const prepared = await prepareBatchUpload(request);
	if (prepared instanceof Response) return prepared;
	const { bulkNew, candidates, results } = prepared;

	// One query reads every member's receipt.
	let operations: Awaited<ReturnType<typeof beginUploadOperations>>;
	try {
		operations = await beginUploadOperations(db, candidates.map(file => ({ id: file.operationId, payload: {
			path: file.safePath, hash: file.hash, size: file.size,
			contentType: file.contentType, expectedHash: file.expectedHash,
		} })));
	} catch (error) {
		return corsResponse({ success: false, results: results.concat(candidates.map(file => validationFailure(file.safePath, formatMutationError(error)))) });
	}
	const checked = await Promise.all(candidates.map(async (file, index) => {
		const operation = operations[index]!;
		if (operation instanceof Response) {
			const receipt = await operation.json() as BatchUploadResponse['results'][number];
			results.push({ ...receipt, path: file.safePath, ...(!receipt.success ? { status: operation.status } : {}) });
			return null;
		}
		return { ...file, operation };
	}));
	const uploads = checked.filter((file): file is NonNullable<typeof file> => file !== null);
	if (!uploads.length) return corsResponse({ success: results.every(result => result.success), results });

	// One lease row names every object of the request, whichever path commits it.
	let leaseId: string;
	let encryptionState: EncryptionServerState | null;
	try {
		const validatedEncryption = await validateUploadEncryption(db, uploads.map(file => ({ path: file.safePath, content: file.bytes, contentType: file.contentType })), expectedEncryption);
		({ id: leaseId, encryptionState } = await trackUploadLease(db, uploads.map(file => ({ storageKey: file.objectKey, path: file.safePath })), {
			encrypted: uploads.every(file => file.contentType === ENCRYPTED_FILE_CONTENT_TYPE), expectedEncryption: validatedEncryption, resetGeneration,
		}));
	} catch (error) {
		if (error instanceof EncryptionStateError) return error.toResponse();
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
			// Descriptors come from the bytes here: the coordinator receives only Markdown bytes.
			const commits = await Promise.all(staged.map(async file => ({
				path: file.safePath, hash: file.hash, size: file.size, objectKey: file.objectKey,
				operation: file.operation, content: file.bytes, leaseId, resetGeneration, encryptionState,
				descriptor: descriptorColumn((await prepareEncryptedFileCommit(db, file.safePath, file.bytes, encryptionState)).descriptor),
			})));
			results.push(...await committers.commitNewFiles(bucket, db, commits));
		} catch (error) {
			failed = true;
			// An uncertain transaction is replayed by operation identity, never cleaned up here.
			results.push(...staged.map(file => ({ path: file.safePath, success: false, status: 503, code: 'storage' as const,
				error: formatMetadataCommitFailure('Upload', formatMutationError(error)) })));
		}
		return corsResponse({ success: results.every(result => result.success), results }, failed ? 503 : 200);
	}

	type Upload = typeof uploads[number];
	let metadataFailure = false;
	const commitInput = (file: Upload) => ({
		encryptionState,
		resetGeneration,
		operation: file.operation,
		path: file.safePath,
		hash: file.hash,
		size: file.size,
		objectKey: file.objectKey,
		leaseId,
		content: file.bytes,
		expectedHash: file.expectedHash,
	});
	const record = (file: Upload, commit: CommitResult) => {
		if (commit.committed) results.push({ path: file.safePath, success: true, hash: file.hash, revision: commit.revision });
		else if (commit.failure) results.push(commit.failure);
		else results.push({
			path: file.safePath,
			success: false,
			error: `Remote file changed since it was read${commit.currentHash ? ` (current hash: ${commit.currentHash})` : ''}`,
			code: 'version_conflict',
			status: 409,
			currentHash: commit.currentHash,
		});
	};
	const fail = (file: Upload, error: unknown) => {
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
	};
	const stored = await Promise.all(uploads.map(async file => {
		try {
			await bucket.put(file.objectKey, file.bytes, {
				httpMetadata: { contentType: file.contentType },
				customMetadata: { hash: file.hash },
			});
			return true;
		} catch (error: unknown) {
			fail(file, error);
			return false;
		}
	}));
	const staged = uploads.filter((_, index) => stored[index]);
	// Several files commit in one transaction. If that fails or its outcome is unknown,
	// each file commits alone by the same operation, which answers from any receipt the
	// batch left behind.
	let commits: CommitResult[] | null = null;
	if (committers.commitUploads && staged.length > 1) {
		try { commits = await committers.commitUploads(bucket, db, staged.map(commitInput)); } catch { commits = null; }
	}
	await Promise.all(staged.map(async (file, index) => {
		try { record(file, commits ? commits[index]! : await committers.commitUpload(bucket, db, commitInput(file))); }
		catch (error: unknown) { fail(file, error); }
	}));

	return corsResponse({ success: results.every((result) => result.success), results }, metadataFailure ? 503 : 200);
}
