import type {
	QueueDeleteCandidate,
	QueueDeleteFailure,
	QueueFlushContext,
} from './queue-flush-types';
import { deleteFilesInBatches } from './delete-batches';

const RETRYABLE_DELETE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function deletePendingFiles(
	context: QueueFlushContext,
	deletes: QueueDeleteCandidate[],
	completedQueueKeys: Set<string>,
): Promise<{ failures: QueueDeleteFailure[]; reconciliationPaths: string[] }> {
	const result = await deleteFilesInBatches(context.api, deletes);

	for (const path of result.deleted) {
		context.localManifest.removeEntry(path);
		completedQueueKeys.add(`delete:${path}`);
	}
	if (result.success) {
		return { failures: [], reconciliationPaths: [] };
	}

	const deletedPaths = new Set(result.deleted);
	const failures: QueueDeleteFailure[] = result.errors && result.errors.length > 0
		? result.errors
		: deletes
			.filter(file => !deletedPaths.has(file.path))
			.map(file => ({ path: file.path, error: 'Batch delete failed' }));

	const reconciliationPaths: string[] = [];
	for (const failure of failures) {
		context.pendingPaths.add(`delete:${failure.path}`);
		if (failure.status !== undefined && !RETRYABLE_DELETE_STATUSES.has(failure.status)) {
			reconciliationPaths.push(`delete:${failure.path}`);
		}
	}
	return { failures, reconciliationPaths };
}
