import { BATCH_DELETE_MAX_FILES } from '../../protocol/sync-limits';
import { isAbortError } from '../abort';
import { errorMessage } from '../../platform/logger';
import type { MutationFailure } from '../../protocol/sync-types';
import { LocalFilePresentError } from '../local/local-absence';
import { BATCH_DELETE_CONCURRENCY } from './constants';
import { fileFailure } from '../failures';

export interface ConditionalDeleteCandidate {
	path: string;
	expectedHash: string;
	expectedRevision?: string;
}

export interface ConditionalDeleteApi {
	batchDelete(paths: string[], expectedHashes?: Record<string, string>, expectedRevisions?: Record<string, string>): Promise<{
		success: boolean;
		deleted: string[];
		errors?: MutationFailure[];
	}>;
}

export interface ConditionalDeleteResult {
	outcome: 'completed' | 'cancelled' | 'failed';
	success: boolean;
	deleted: string[];
	errors: MutationFailure[];
}

export async function deleteFilesInBatches(
	api: ConditionalDeleteApi,
	files: ConditionalDeleteCandidate[],
	assertAbsent?: (path: string) => Promise<void>,
	onProcessed?: (count: number) => void,
): Promise<ConditionalDeleteResult> {
	const deleted: string[] = [];
	const errors: MutationFailure[] = [];
	let nextIndex = 0;
	let stopped = false;
	let cancelled = false;

	async function worker(): Promise<void> {
		while (!stopped && nextIndex < files.length) {
			const index = nextIndex;
			nextIndex += BATCH_DELETE_MAX_FILES;
			const chunk = files.slice(index, index + BATCH_DELETE_MAX_FILES);
			try {
				await Promise.all(chunk.map(async file => { await assertAbsent?.(file.path); }));
				if (cancelled) return;
				const response = await api.batchDelete(
					chunk.map((file) => file.path),
					Object.fromEntries(chunk.map((file) => [file.path, file.expectedHash])),
					Object.fromEntries(chunk.flatMap((file) => file.expectedRevision ? [[file.path, file.expectedRevision]] : [])),
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
				stopped = true;
				if (isAbortError(error)) { cancelled = true; return; }
				// A file that reappeared locally replans like a server-side version change.
				const failure = (path: string): MutationFailure => error instanceof LocalFilePresentError
					? { path, error: errorMessage(error), status: 409, code: 'version_conflict' }
					: fileFailure(path, error);
				const unsent = files.slice(nextIndex);
				nextIndex = files.length;
				for (const file of [...chunk, ...unsent]) errors.push(failure(file.path));
			}
			onProcessed?.(chunk.length);
		}
	}
	// Drain dispatched requests before returning so cancellation cannot discard
	// acknowledgements from a sibling request that already committed.
	await Promise.all(Array.from({ length: Math.min(BATCH_DELETE_CONCURRENCY, Math.ceil(files.length / BATCH_DELETE_MAX_FILES)) }, worker));

	const acknowledged = new Set(deleted);
	return { outcome: cancelled ? 'cancelled' : errors.length === 0 ? 'completed' : 'failed', success: !cancelled && errors.length === 0, deleted: files.filter(file => acknowledged.has(file.path)).map(file => file.path), errors };
}
