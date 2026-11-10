import { corsResponse } from '../../http/cors';
import { COMMIT_CONTEXT_COLUMNS, commitFileDeletes, parseCommitContext, type CommitContextRow, type CommitResult, type FileDeleteInput } from '../mutations';
import { parseJsonObject, parseOptionalString, sanitizePath } from '../../http/request-validation';
import {
	formatMetadataCommitFailure,
	formatMutationError,
	loadStoredFileRows,
	MAX_BATCH_DELETE_FILES,
	parseExpectedFileHash,
	type FileStorageRow,
} from '../storage';
import type { BatchDeleteFile } from './types';
import type { MutationFailure } from '../../../../protocol/sync-types';
import { mutationAuditContext } from '../../http/request-diagnostics';
import type { FileDeletionReceipt } from '../file-delete-audit';

export async function handleBatchDelete(
	request: Request,
	bucket: R2Bucket,
	db: D1Database,
	audit = mutationAuditContext(request),
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
	const results: Array<{ path: string } & Partial<FileDeletionReceipt>> = [];
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
	let context: ReturnType<typeof parseCommitContext> = {};
	if (validFiles.length > 0) {
		try {
			previousFiles = await loadStoredFileRows(db, validFiles.map((file) => file.path));
			// Read once for every member instead of once per file; the coordinator lock
			// serializes the writers of these rows.
			if (previousFiles.size) context = parseCommitContext(await db.prepare(`SELECT ${COMMIT_CONTEXT_COLUMNS}`).first<CommitContextRow>());
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

	// Like an absent file, a stale precondition is answered from the batch's snapshot,
	// so a batch of stale deletes needs no write or second read per file.
	const current = validFiles.filter(file => {
		const previousFile = previousFiles.get(file.path);
		return !previousFile || previousFile.hash === file.expectedHash && previousFile.storageKey === file.expectedRevision;
	});
	const deletion = (file: typeof validFiles[number]): FileDeleteInput => ({
		path: file.path,
		expectedHash: file.expectedHash,
		expectedRevision: file.expectedRevision,
		previousFile: previousFiles.get(file.path) ?? null,
		audit,
		reminderFolder: context.reminderFolder,
		readingPolicy: context.readingPolicy,
	});
	const commits = new Map<string, CommitResult | { failure: unknown }>();
	try {
		// One transaction and one round trip for the whole batch. An uncertain outcome is
		// reported for every member, and a retry answers from the receipts it left.
		(await commitFileDeletes(db, current.map(deletion))).forEach((commit, index) => commits.set(current[index]!.path, commit));
	} catch (failure: unknown) {
		for (const file of current) commits.set(file.path, { failure });
	}

	let metadataFailure = false;
	for (const file of validFiles) {
		const commit = commits.get(file.path);
		if (!commit) {
			errors.push(versionConflict(file.path, previousFiles.get(file.path)!.hash));
		} else if ('failure' in commit) {
			metadataFailure = true;
			errors.push({
				path: file.path,
				error: formatMetadataCommitFailure('Delete', formatMutationError(commit.failure)),
				code: 'storage',
				status: 503,
			});
		} else if (!commit.committed) {
			errors.push(versionConflict(file.path, commit.currentHash));
		} else {
			deleted.push(file.path);
			results.push({ path: file.path, ...commit.deletion });
		}
	}

	return corsResponse({
		success: errors.length === 0,
		deleted,
		...(results.length > 0 ? { results } : {}),
		...(errors.length > 0 ? { errors } : {}),
	}, metadataFailure ? 503 : 200);
}

function validationFailure(path: string, error: string): MutationFailure {
	return { path, error, code: 'validation', status: 400 };
}

function versionConflict(path: string, currentHash: string | null): MutationFailure {
	return { path, error: 'Remote file changed since it was read', code: 'version_conflict', status: 409, currentHash };
}
