import type {
	QueueDeleteCandidate,
	QueueDeleteFailure,
	QueueFlushContext,
} from './queue-flush-types';
import { deleteFilesInBatches } from './delete-batches';
import { isQueueTerminalFailure, isQueueVersionConflict } from './queue-failure';

export async function deletePendingFiles(
	context: QueueFlushContext,
	deletes: QueueDeleteCandidate[],
	completedQueueKeys: Set<string>,
): Promise<{ failures: QueueDeleteFailure[]; reconciliationPaths: string[]; hasTerminalFailure: boolean }> {
	const result = await deleteFilesInBatches(context.api, deletes);

	for (const path of result.deleted) {
		context.localManifest.removeEntry(path);
		completedQueueKeys.add(`delete:${path}`);
	}
	if (result.success) {
		return { failures: [], reconciliationPaths: [], hasTerminalFailure: false };
	}

	const deletedPaths = new Set(result.deleted);
	const failures: QueueDeleteFailure[] = result.errors && result.errors.length > 0
		? result.errors
		: deletes
			.filter(file => !deletedPaths.has(file.path))
			.map(file => ({ path: file.path, error: 'Batch delete failed' }));

	const reconciliationPaths: string[] = [];
	let hasTerminalFailure = false;
	for (const failure of failures) {
		context.pendingPaths.add(`delete:${failure.path}`);
		if (isQueueVersionConflict(failure.status)) {
			reconciliationPaths.push(`delete:${failure.path}`);
		}
		if (isQueueTerminalFailure(failure.status)) hasTerminalFailure = true;
	}
	return { failures, reconciliationPaths, hasTerminalFailure };
}
