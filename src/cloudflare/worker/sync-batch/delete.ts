import { corsResponse } from '../cors';
import { commitFileDelete } from '../sync-mutations';
import { parseJsonObject, sanitizePath } from '../utils';
import {
	formatMetadataCommitFailure,
	formatMutationError,
	loadStoredFileRows,
	MAX_BATCH_DELETE_FILES,
	parseExpectedFileHash,
	type FileStorageRow,
} from '../sync-storage';
import type { BatchDeleteFile } from './types';

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
