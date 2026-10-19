import { pendingChangeKey } from '../pending-change';
import { createEmptySyncResult } from '../sync-result';
import type { PreparedUpload } from '../types';
import type { QueueFlushContext, QueueUploadFailure } from './flush-types';

/** Queue settlement is mode-specific; transfer and acknowledgement are shared. */
export async function uploadPendingFiles(
	context: QueueFlushContext,
	uploads: PreparedUpload[],
	completedQueueKeys: Set<string>,
	onProcessed: (count: number) => void,
): Promise<QueueUploadFailure[]> {
	const result = createEmptySyncResult();
	const conflicts: string[] = [];
	const failures: QueueUploadFailure[] = [];
	try {
		await context.uploadPreparedFiles(uploads, result, {
			retry: false,
			onProcessed,
			onFailure: failure => { failures.push(failure); },
			onVersionConflicts: async paths => { conflicts.push(...paths); },
		});
	} finally {
		// Preserve accepted siblings when another in-flight request is cancelled.
		for (const path of result.uploadedPaths) completedQueueKeys.add(pendingChangeKey('upload', path));
	}
	return [
		...failures,
		...conflicts.map(path => ({ path, error: 'Remote file changed since it was read', status: 409, code: 'version_conflict' })),
	];
}
