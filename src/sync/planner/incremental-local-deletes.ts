import type { IncrementalSyncPlannerContext } from './types';
import type { SyncResult } from '../types';
import { createDeleteCandidates, deleteRemoteFiles } from '../transfer/delete';
import type { MutationFailure } from '../../protocol/sync-types';

/** Plan from the acknowledged baseline; all transfer policy lives in the shared executor. */
export async function applyIncrementalLocalDeletes(
	context: Pick<IncrementalSyncPlannerContext, 'api' | 'vault' | 'localManifest' | 'reconcileVersionConflicts' | 'reportWork'>,
	paths: readonly string[],
	result: SyncResult,
	onProcessed?: (count: number) => void,
): Promise<MutationFailure[]> {
	const files = createDeleteCandidates(paths.map(path => {
		const entry = context.localManifest.getEntry(path);
		return { path, hash: entry?.hash, revision: entry?.revision };
	}), result);
	return deleteRemoteFiles({ ...context, reportWork: work => context.reportWork?.(work.phase, work.current, work.total) }, files, result, {
		onProcessed,
		onVersionConflicts: context.reconcileVersionConflicts,
	});
}
