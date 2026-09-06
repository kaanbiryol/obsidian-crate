import { corsResponse } from '../cors';
import { commitFileDelete } from '../sync-mutations';
import { parseJsonObject, parseOptionalString, sanitizePath } from '../utils';
import {
	formatMetadataCommitFailure,
	formatMutationError,
	loadStoredFileRows,
	MAX_BATCH_DELETE_FILES,
	parseExpectedFileHash,
	type FileStorageRow,
} from '../sync-storage';
import type { BatchDeleteFile } from './types';
import type { MutationFailure } from '../../../protocol/sync-types';

export async function handleBatchDelete(
	request: Request,
	bucket: R2Bucket,
	db: D1Database,
): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}
	const rawFiles = parsedBody.value.files;
	if (!Array.isArray(rawFiles) || rawFiles.length === 0 || rawFiles.length > MAX_BATCH_DELETE_FILES) {
		return corsResponse({ error: `files array required (maximum ${MAX_BATCH_DELETE_FILES})` }, 400);
	}

	const deleted: string[] = [];
	const errors: MutationFailure[] = [];
	const validFiles: Array<{ path: string; expectedHash: string; expectedRevision: string }> = [];
	const seenPaths = new Set<string>();

	for (const rawFile of rawFiles as BatchDeleteFile[]) {
		const rawPath = typeof rawFile?.path === 'string' ? rawFile.path : '';
		const safePath = sanitizePath(rawPath);
		if (!safePath) {
			errors.push(validationFailure(rawPath, 'Invalid path'));
			continue;
		}
		if (seenPaths.has(safePath)) {
			errors.push(validationFailure(safePath, 'Duplicate path in batch'));
			continue;
		}
		seenPaths.add(safePath);
		const expectedHash = parseExpectedFileHash(rawFile.expectedHash);
		if (expectedHash === undefined || expectedHash === null) {
			errors.push(validationFailure(safePath, 'Valid expectedHash required'));
			continue;
		}

		const expectedRevision = parseOptionalString(rawFile.expectedRevision, 1024);
		if (!expectedRevision) {
			errors.push(validationFailure(safePath, 'expectedRevision required; refresh before deleting'));
			continue;
		}
		validFiles.push({ path: safePath, expectedHash, expectedRevision });
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
					code: 'storage' as const,
					status: 503,
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
				expectedRevision: file.expectedRevision,
				previousFile: previousFiles.get(file.path) ?? null,
			});
			if (!commit.committed) {
				errors.push({
					path: file.path,
					error: 'Remote file changed since it was read',
					code: 'version_conflict',
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
				code: 'storage',
				status: 503,
			});
		}
	}

	return corsResponse({
		success: errors.length === 0,
		deleted,
		...(errors.length > 0 ? { errors } : {}),
	}, metadataFailure ? 503 : 200);
}

function validationFailure(path: string, error: string): MutationFailure {
	return { path, error, code: 'validation', status: 400 };
}
