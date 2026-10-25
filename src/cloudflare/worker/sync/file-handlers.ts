import type { EncryptionServerState } from '../../../encryption/server-state';
import { trackStagedUploads } from './staging/staged-uploads';
import { ENCRYPTED_FILE_CONTENT_TYPE, fileTransportLimit, MAX_ENCRYPTED_FILE_BYTES } from '../../../encryption/file-format';
import { EncryptionStateError, validateUploadEncryption } from '../encryption/state';
import { beginUploadOperation } from './upload-operations';
import { exactArrayBuffer, readLimitedRequestBody } from '../body-reader';
import { corsHeaders, corsResponse } from '../cors';
import { sanitizePath } from '../request-validation';
import type { UploadCommitters } from './staging/upload-committers';
import { FileNamespaceConflictError } from './file-namespace';
import {
	formatMetadataCommitFailure,
	formatMutationError,
	getStoredFileRow,
	parseExpectedFileHash,
	parseDeclaredSize,
	storedObjectMatchesMetadata,
	type FileStorageRow,
} from './storage';
import { isSha256Hex } from '../../../platform/validation';
import { createManagedObjectKey } from '../../../protocol/storage-keys';
import { FILE_HASH_HEADER, FILE_SIZE_HEADER, EXPECTED_HASH_HEADER, UPLOAD_OPERATION_HEADER, REVISION_HEADER } from '../../../protocol/http-headers';
import { sha256Hex } from '../../../platform/sha256';

export async function handleUpload(request: Request, bucket: R2Bucket, db: D1Database, committers: UploadCommitters, expectedEncryption?: EncryptionServerState | null, resetGeneration?: string | null): Promise<Response> {
	const limit = fileTransportLimit(request.headers.get('Content-Type') ?? undefined);
	const url = new URL(request.url);
	const rawPath = url.searchParams.get('path');
	if (!rawPath) return corsResponse({ error: 'Path query parameter required' }, 400);

	const safePath = sanitizePath(rawPath);
	if (!safePath) return corsResponse({ error: 'Invalid path' }, 400);

	const hashHeader = request.headers.get(FILE_HASH_HEADER)?.trim().toLowerCase() || '';
	if (hashHeader && !isSha256Hex(hashHeader)) {
		return corsResponse({ error: 'Invalid X-File-Hash header' }, 400);
	}

	const declaredSize = parseDeclaredSize(request.headers.get(FILE_SIZE_HEADER));
	if (request.headers.has(FILE_SIZE_HEADER) && declaredSize === null) {
		return corsResponse({ error: 'Invalid X-File-Size header' }, 400);
	}
	const contentLength = parseDeclaredSize(request.headers.get('Content-Length'));
	if (request.headers.has('Content-Length') && contentLength === null) {
		return corsResponse({ error: 'Invalid Content-Length header' }, 400);
	}
	if ((declaredSize ?? 0) > limit || (contentLength ?? 0) > limit) {
		return corsResponse({ error: 'File exceeds 25MB limit' }, 413);
	}

	const expectedHash = parseExpectedFileHash(request.headers.get(EXPECTED_HASH_HEADER));
	if (!request.headers.has(EXPECTED_HASH_HEADER) || expectedHash === undefined) {
		return corsResponse({ error: 'Valid X-Crate-Expected-Hash header required' }, 400);
	}
	const expectedRemoteHash = expectedHash;

	const contentType = request.headers.get('Content-Type') || 'application/octet-stream';

	try {
		const bodyResult = await readLimitedRequestBody(request, limit, 'File exceeds its transfer limit');
		if (!bodyResult.ok) return bodyResult.response;
		const body = bodyResult.bytes;
		const computedSize = body.byteLength;
		if (declaredSize !== null && declaredSize !== computedSize) {
			return corsResponse({ error: 'File size does not match X-File-Size header' }, 400);
		}

		const computedHash = await sha256Hex(body);
		if (hashHeader && hashHeader !== computedHash) {
			return corsResponse({ error: 'File hash does not match X-File-Hash header' }, 400);
		}

		const hash = hashHeader || computedHash;
		const size = declaredSize ?? computedSize;
		const operation = await beginUploadOperation(db, request.headers.get(UPLOAD_OPERATION_HEADER), { path: safePath, hash, size, contentType, expectedHash: expectedRemoteHash });
		if (operation instanceof Response) return operation;
		const objectKey = createManagedObjectKey(hash);
		const validatedEncryption = await validateUploadEncryption(db, [{ path: safePath, content: body, contentType }], expectedEncryption);
		const encryptionState = await trackStagedUploads(db, [{ storageKey: objectKey, path: safePath }], contentType === ENCRYPTED_FILE_CONTENT_TYPE, validatedEncryption, resetGeneration);
		await bucket.put(objectKey, body, {
			httpMetadata: { contentType },
			customMetadata: { hash },
		});

		let revision: string | undefined;
		try {
			const commit = await committers.commitUpload(bucket, db, {
				path: safePath,
				hash,
				size,
				objectKey,
				content: exactArrayBuffer(body),
				expectedHash: expectedRemoteHash,
				operation,
				encryptionState,
				resetGeneration,
			});
			revision = commit.revision;
			if (!commit.committed) {
				if (commit.failure) return corsResponse(commit.failure, commit.failure.status ?? 409);
				return corsResponse({
					success: false,
					path: safePath,
					error: 'Remote file changed since it was read',
					code: 'version_conflict',
					currentHash: commit.currentHash,
				}, 409);
			}
		} catch (error: unknown) {
			// The transaction may have committed before its response was lost.
			if (error instanceof EncryptionStateError) return corsResponse({ error: error.message, code: 'encryption_required' }, error.status);
			if (error instanceof FileNamespaceConflictError) return error.toResponse();
			// Only the age-delayed, reference-aware orphan sweep may reclaim it.
			return corsResponse({
				success: false,
				path: safePath,
				error: formatMetadataCommitFailure('Upload', formatMutationError(error)),
			}, 503);
		}

		return corsResponse({ success: true, path: safePath, hash, revision });
	} catch (err: unknown) {
		if (err instanceof EncryptionStateError) return corsResponse({ error: err.message, code: 'encryption_required' }, err.status);
		const message = formatMutationError(err);
		return corsResponse({ success: false, path: safePath, error: message }, 500);
	}
}

export async function handleDownload(request: Request, bucket: R2Bucket, db: D1Database): Promise<Response> {
	const url = new URL(request.url);
	const rawPath = url.searchParams.get('path');
	if (!rawPath) return corsResponse({ error: 'Path query parameter required' }, 400);

	const path = sanitizePath(rawPath);
	if (!path) return corsResponse({ error: 'Invalid path' }, 400);

	let storedFile: FileStorageRow | null = null;
	try {
		storedFile = await getStoredFileRow(db, path);
	} catch {
		return corsResponse({ error: 'Sync metadata unavailable' }, 503);
	}

	const objectKey = storedFile?.storageKey ?? null;
	if (!objectKey) return corsResponse({ error: 'File not found' }, 404);
	if (storedFile && storedFile.size > MAX_ENCRYPTED_FILE_BYTES) {
		return corsResponse({ error: 'File exceeds 25MB download limit' }, 413);
	}

	const obj = await bucket.get(objectKey);
	if (!obj) {
		return corsResponse({ error: 'File content unavailable' }, 503);
	}
	if (storedFile && !storedObjectMatchesMetadata(obj, storedFile)) {
		return corsResponse({ error: 'File content failed integrity validation' }, 503);
	}
	if (obj.size > fileTransportLimit(obj.httpMetadata?.contentType)) {
		return corsResponse({ error: 'File exceeds 25MB download limit' }, 413);
	}

	return new Response(obj.body, {
		status: 200,
		headers: {
			'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
			'Content-Length': String(obj.size),
			'Cache-Control': 'private, no-store',
			[REVISION_HEADER]: storedFile?.storageKey ?? '',
			[FILE_HASH_HEADER]: storedFile?.hash || obj.customMetadata?.hash || '',
			...corsHeaders(),
		},
	});
}
