import { createEmptySyncResult, finalizeSyncResult } from '../sync-result';
import { createLogger } from '../logger';
import type { SyncResult } from '../types';
import type { MutationFailure } from '../../protocol/sync-types';
import {
	beginSyncAttempt,
	completeTransferResult,
	handleWorkflowError,
	type SyncStatus,
	type WorkflowCompletionContext,
} from '../sync-outcome';

const logger = createLogger('SyncEngine');

export interface ReconcileWorkflowContext extends WorkflowCompletionContext {
	apiConfigured(): boolean;
	getStatus(): SyncStatus;
	snapshotPendingRevisions(): ReadonlyMap<string, number>;
	/** Reconciles the paths with the server, first recovering interrupted uploads when `recover` is set. */
	reconcilePaths(queueKeys: string[], recover: boolean, onFailure: (failure: MutationFailure) => void): Promise<SyncResult>;
	settleSynced(result: SyncResult, revisions: ReadonlyMap<string, number>): Promise<void>;
	finishInitialSetup(): Promise<void>;
	/** Runs after a successful reconciliation. */
	onSucceeded(): void;
}

/** Reconciles queued or selected paths and publishes the outcome. A selected-file
 * sync neither recovers interrupted uploads nor finishes initial setup. */
export async function runReconcileWorkflow(
	context: ReconcileWorkflowContext,
	queueKeys: string[],
	selectedOnly = false,
): Promise<SyncResult> {
	const pendingRevisionSnapshot = context.snapshotPendingRevisions();
	const startFailure = beginSyncAttempt(context);
	if (startFailure) return startFailure;
	let result = createEmptySyncResult();
	const failures: MutationFailure[] = [];
	try {
		result = await context.reconcilePaths(queueKeys, !selectedOnly, failure => { failures.push(failure); });
		if (result.outcome !== 'cancelled') {
			await context.settleSynced(result, pendingRevisionSnapshot);
			if (result.success && !selectedOnly) await context.finishInitialSetup();
		}
		completeTransferResult(context, result, failures, { errorFallback: 'Reconciliation failed', failureLogPrefix: 'Reconciliation failed', logger });
		if (result.success) context.onSucceeded();
		return result;
	} catch (error) {
		handleWorkflowError(context, result, error, {
			abortLogMessage: 'Reconciliation aborted',
			failureLogPrefix: 'Reconciliation failed',
			logger,
		});
		finalizeSyncResult(result);
		return result;
	}
}
