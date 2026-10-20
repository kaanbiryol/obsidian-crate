import { pendingChangeKey } from '../pending/pending-change';
import type {
	QueueDeleteCandidate,
	QueueDeleteFailure,
	QueueFlushContext,
} from './flush-types';
import { createEmptySyncResult } from '../sync-result';
import { isQueueTerminalFailure, isVersionConflict } from '../failures';

export async function deletePendingFiles(
	context: QueueFlushContext,
	deletes: QueueDeleteCandidate[],
	completedQueueKeys: Set<string>,
): Promise<{ failures: QueueDeleteFailure[]; reconciliationPaths: string[]; hasTerminalFailure: boolean }> {
	const result = createEmptySyncResult();
	let failures: QueueDeleteFailure[];
	try {
		failures = await context.deleteRemoteFiles(deletes, result);
	} finally {
		for (const path of result.deletedPaths) completedQueueKeys.add(pendingChangeKey('delete', path));
	}

	const reconciliationPaths: string[] = [];
	let hasTerminalFailure = false;
	for (const failure of failures) {
		if (isVersionConflict(failure.status, failure.code)) {
			reconciliationPaths.push(pendingChangeKey('delete', failure.path));
		}
		if (isQueueTerminalFailure(failure.status, failure.code)) hasTerminalFailure = true;
	}
	return { failures, reconciliationPaths, hasTerminalFailure };
}
