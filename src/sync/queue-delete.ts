import type {
	QueueDeleteCandidate,
	QueueDeleteFailure,
	QueueFlushContext,
} from './queue-flush-types';

const RETRYABLE_DELETE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function deletePendingFiles(
	context: QueueFlushContext,
	deletes: QueueDeleteCandidate[],
	completedQueueKeys: Set<string>,
): Promise<QueueDeleteFailure[]> {
	const result = await context.api.batchDelete(
		deletes.map(file => file.path),
		Object.fromEntries(deletes.map(file => [file.path, file.expectedHash])),
	);

	for (const path of result.deleted) {
		context.localManifest.removeEntry(path);
		completedQueueKeys.add(`delete:${path}`);
	}
	if (result.success) {
		return [];
	}

	const deletedPaths = new Set(result.deleted);
	const failures: QueueDeleteFailure[] = result.errors && result.errors.length > 0
		? result.errors
		: deletes
			.filter(file => !deletedPaths.has(file.path))
			.map(file => ({ path: file.path, error: 'Batch delete failed' }));

	for (const failure of failures) {
		if (failure.status === undefined || RETRYABLE_DELETE_STATUSES.has(failure.status)) {
			context.pendingPaths.add(`delete:${failure.path}`);
		}
	}
	return failures;
}
