import { createLogger, errorMessage } from '../plugin/logger';
import { isAbortError } from './abort';
import { isRetryableSyncError } from './engine-utils';
import { deletePendingFiles } from './queue-delete';
import type { QueueFlushContext } from './queue-flush-types';
import { prepareQueueOperations, uploadPendingFiles } from './queue-upload';
import { isQueueTerminalFailure, isQueueVersionConflict } from './queue-failure';
import { HttpError } from './api';

export type { QueueFlushContext } from './queue-flush-types';

const logger = createLogger('SyncQueue');

function clearCompletedRevisions(
	context: QueueFlushContext,
	completedQueueKeys: Set<string>,
	revisionSnapshot: ReadonlyMap<string, number | undefined>,
): void {
	for (const path of completedQueueKeys) {
		const startingRevision = revisionSnapshot.get(path);
		if (
			!context.pendingPaths.has(path)
			&& context.pendingRevisions?.get(path) === startingRevision
		) {
			context.pendingRevisions?.delete(path);
		}
	}
}

export async function processPendingChanges(
	context: QueueFlushContext,
	uploadConcurrency: number,
): Promise<void> {
	if (context.isDestroyed()) return;

	if (context.pendingPaths.size === 0) {
		context.updateState({ pendingChanges: 0 });
		return;
	}
	if (context.currentStatus() === 'syncing') {
		context.updateState({ pendingChanges: context.pendingPaths.size });
		context.triggerDebouncedSync();
		return;
	}
	if (!context.api.isConfigured()) {
		context.updateState({ pendingChanges: context.pendingPaths.size });
		return;
	}

	const paths = Array.from(context.pendingPaths);
	const revisionSnapshot = new Map(
		paths.map(path => [path, context.pendingRevisions?.get(path)] as const),
	);
	const completedQueueKeys = new Set<string>();
	const reconciliationPaths = new Set<string>();
	let hasTerminalFailure = false;
	for (const path of paths) {
		context.pendingPaths.delete(path);
		context.inFlightPaths.add(path);
	}

	logger.info(`Processing ${paths.length} pending changes`);
	context.updateState({ status: 'syncing', pendingChanges: context.pendingPaths.size });

	try {
		const { uploads, deletes } = await prepareQueueOperations(context, paths);
		const failures: Array<{ path: string; error: string; status?: number }> = [];
		if (uploads.length > 0) {
			const uploadFailures = await uploadPendingFiles(context, uploads, completedQueueKeys, uploadConcurrency);
			for (const failure of uploadFailures) {
				context.pendingPaths.add(failure.path);
				if (isQueueVersionConflict(failure.status)) reconciliationPaths.add(failure.path);
				if (isQueueTerminalFailure(failure.status)) hasTerminalFailure = true;
			}
			failures.push(...uploadFailures);
		}

		if (deletes.length > 0) {
			const deleteResult = await deletePendingFiles(context, deletes, completedQueueKeys);
			failures.push(...deleteResult.failures);
			for (const path of deleteResult.reconciliationPaths) reconciliationPaths.add(path);
			if (deleteResult.hasTerminalFailure) hasTerminalFailure = true;
		}

		await context.localManifest.save();
		clearCompletedRevisions(context, completedQueueKeys, revisionSnapshot);
		if (failures.length > 0) {
			context.updateState({
				status: 'error',
				lastError: failures.map(failure => `${failure.path}: ${failure.error}`).join('; '),
				pendingChanges: context.pendingPaths.size,
			});
			if (reconciliationPaths.size > 0) context.requestReconciliation([...reconciliationPaths]);
			return;
		}

		context.inFlightPaths.clear();
		const didWork = uploads.length > 0 || deletes.length > 0;
		context.updateState({
			status: 'idle',
			...(didWork ? { lastSync: new Date().toISOString(), lastError: null } : {}),
			pendingChanges: context.pendingPaths.size,
		});
	} catch (error) {
		if (isAbortError(error)) {
			logger.info('Queue processing aborted');
		} else {
			const retryable = isRetryableSyncError(error);
			for (const path of paths) {
				if (!completedQueueKeys.has(path)) context.pendingPaths.add(path);
			}
			if (!retryable) {
				if (error instanceof HttpError && isQueueVersionConflict(error.status)) {
					for (const path of paths) {
						if (!completedQueueKeys.has(path)) reconciliationPaths.add(path);
					}
				} else {
					hasTerminalFailure = true;
				}
			}
			context.updateState({
				status: 'error',
				lastError: errorMessage(error),
				pendingChanges: context.pendingPaths.size,
			});
			if (reconciliationPaths.size > 0) context.requestReconciliation([...reconciliationPaths]);
		}
	} finally {
		context.inFlightPaths.clear();
		if (
			!context.isDestroyed()
			&& context.pendingPaths.size > 0
			&& reconciliationPaths.size === 0
			&& !hasTerminalFailure
		) {
			context.triggerDebouncedSync();
		}
	}
}
