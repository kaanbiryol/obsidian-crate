import { BATCH_DELETE_MAX_FILES } from '../protocol/sync-limits';
import { HttpError } from './api';
import { errorMessage } from '../plugin/logger';

export interface ConditionalDeleteCandidate {
	path: string;
	expectedHash: string;
}

interface ConditionalDeleteFailure {
	path: string;
	error: string;
	status?: number;
	currentHash?: string | null;
}

interface ConditionalDeleteApi {
	batchDelete(paths: string[], expectedHashes?: Record<string, string>): Promise<{
		success: boolean;
		deleted: string[];
		errors?: ConditionalDeleteFailure[];
	}>;
}

export interface ConditionalDeleteResult {
	success: boolean;
	deleted: string[];
	errors: ConditionalDeleteFailure[];
}

export async function deleteFilesInBatches(
	api: ConditionalDeleteApi,
	files: ConditionalDeleteCandidate[],
): Promise<ConditionalDeleteResult> {
	const deleted: string[] = [];
	const errors: ConditionalDeleteFailure[] = [];

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
			const message = errorMessage(error);
			for (const file of files.slice(index)) {
				errors.push({ path: file.path, error: message, ...(status === undefined ? {} : { status }) });
			}
			break;
		}
	}

	return { success: errors.length === 0, deleted, errors };
}
