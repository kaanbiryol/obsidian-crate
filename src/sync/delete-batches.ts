import { BATCH_DELETE_MAX_FILES } from '../protocol/sync-limits';
import { HttpError } from './api';
import { errorMessage } from '../plugin/logger';
import type { MutationFailure } from '../plugin/types';

export interface ConditionalDeleteCandidate {
	path: string;
	expectedHash: string;
}

interface ConditionalDeleteApi {
	batchDelete(paths: string[], expectedHashes?: Record<string, string>): Promise<{
		success: boolean;
		deleted: string[];
		errors?: MutationFailure[];
	}>;
}

export interface ConditionalDeleteResult {
	success: boolean;
	deleted: string[];
	errors: MutationFailure[];
}

export async function deleteFilesInBatches(
	api: ConditionalDeleteApi,
	files: ConditionalDeleteCandidate[],
): Promise<ConditionalDeleteResult> {
	const deleted: string[] = [];
	const errors: MutationFailure[] = [];

	for (let index = 0; index < files.length; index += BATCH_DELETE_MAX_FILES) {
		const chunk = files.slice(index, index + BATCH_DELETE_MAX_FILES);
		try {
			const response = await api.batchDelete(
				chunk.map((file) => file.path),
				Object.fromEntries(chunk.map((file) => [file.path, file.expectedHash])),
			);
			const expectedPaths = new Set(chunk.map((file) => file.path));
			const deletedPaths = new Set(response.deleted);
			if (
				deletedPaths.size !== response.deleted.length
				|| response.deleted.some((path) => !expectedPaths.has(path))
			) {
				throw new Error('Batch delete response did not match the requested paths');
			}

			deleted.push(...response.deleted);
			const responseErrors = response.errors ?? [];
			const failedPaths = new Set(responseErrors.map((failure) => failure.path));
			for (const failure of responseErrors) {
				if (expectedPaths.has(failure.path)) errors.push(failure);
			}
			for (const file of chunk) {
				if (!deletedPaths.has(file.path) && !failedPaths.has(file.path)) {
					errors.push({ path: file.path, error: 'Batch delete failed' });
				}
			}
		} catch (error) {
			const status = error instanceof HttpError ? error.status : undefined;
			const code = error instanceof HttpError && isMutationFailureCode(error.code)
				? error.code
				: undefined;
			const currentHash = error instanceof HttpError ? error.currentHash : undefined;
			const message = errorMessage(error);
			for (const file of files.slice(index)) {
				errors.push({
					path: file.path,
					error: message,
					...(status === undefined ? {} : { status }),
					...(code === undefined ? {} : { code }),
					...(currentHash === undefined ? {} : { currentHash }),
				});
			}
			break;
		}
	}

	return { success: errors.length === 0, deleted, errors };
}

function isMutationFailureCode(value: string | undefined): value is NonNullable<MutationFailure['code']> {
	return value === 'version_conflict'
		|| value === 'validation'
		|| value === 'storage'
		|| value === 'unknown';
}
