import type { EncryptionServerState } from '../../../encryption/server-state';
import { BULK_NEW_UPLOAD_MAX_FILES, BATCH_ASSET_UPLOAD_MAX_FILES } from '../../../protocol/sync-limits';
import type { BatchUploadResponse } from '../../../protocol/sync-types';
import { sha256HexBytes } from '../auth';
import { corsResponse } from '../cors';
import { isSha256Hex, parseJsonObject, parseNonNegativeInteger, parseOptionalString, sanitizePath } from '../utils';
import {
	createManagedObjectKey, formatMutationError, MAX_BATCH_UPLOAD_FILES, MAX_BATCH_TOTAL_BYTES,
	parseExpectedFileHash, type ExpectedFileHash,
} from '../sync-storage';
import type { BatchFile } from './types';

/** Validate and decode the complete request before receipts, staging or commits. */
export async function prepareBatchUpload(request: Request, expectedEncryption?: EncryptionServerState | null) {
	const parsedBody = await parseJsonObject(request, 15 * 1024 * 1024);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const files = parsedBody.value.files;
	if (!Array.isArray(files) || files.length === 0) {
		return corsResponse({ error: 'files array required' }, 400);
	}
	const bulkNew = parsedBody.value.bulkNewFiles === true;
	if (bulkNew && expectedEncryption) return corsResponse({ error: 'Bulk imports are unavailable for encrypted requests' }, 428);
	if (bulkNew && !(files as BatchFile[]).every(file => parseExpectedFileHash(file?.expectedHash) === null)) {
		return corsResponse({ error: 'Bulk new-file uploads require absent preconditions' }, 400);
	}
	if (bulkNew && new Set((files as BatchFile[]).map(file => file?.operationId)).size !== files.length) {
		return corsResponse({ error: 'Duplicate operation identity in bulk upload' }, 400);
	}
	const maxFiles = bulkNew ? BULK_NEW_UPLOAD_MAX_FILES : (files as BatchFile[]).every(file => typeof file?.path === 'string' && !file.path.toLowerCase().endsWith('.md'))
		? BATCH_ASSET_UPLOAD_MAX_FILES : MAX_BATCH_UPLOAD_FILES;
	if (files.length > maxFiles) {
		return corsResponse({ error: `Maximum ${maxFiles} files per batch` }, 400);
	}

	const results: BatchUploadResponse['results'] = [];
	const candidates: Array<{
		operationId: unknown;
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

			const contentType = parseOptionalString(file.contentType, 255) || 'application/octet-stream';
			candidates.push({
				operationId: file.operationId,
				safePath,
				bytes: bytes.buffer,
				hash: providedHash || computedHash,
				size,
				contentType,
				objectKey: createManagedObjectKey(providedHash || computedHash),
				expectedHash: expectedHash ?? null,
			});
		} catch (error: unknown) {
			results.push(validationFailure(safePath, formatMutationError(error)));
		}
	}

	return { bulkNew, candidates, results };
}

export function validationFailure(
	path: string,
	error: string,
): BatchUploadResponse['results'][number] {
	return { path, success: false, error, code: 'validation', status: 400 };
}
