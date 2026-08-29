import { createLogger, errorMessage } from '../plugin/logger';
import { isAbortError } from './abort';
import { isRetryableSyncError } from './engine-utils';
import { deletePendingFiles } from './queue-delete';
import type { QueueFlushContext } from './queue-flush-types';
import { prepareQueueOperations, uploadPendingFiles } from './queue-upload';

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
	for (const path of paths) {
		context.pendingPaths.delete(path);
		context.inFlightPaths.add(path);
	}

	logger.info(`Processing ${paths.length} pending changes`);
	context.updateState({ status: 'syncing', pendingChanges: context.pendingPaths.size });

	try {
		const { uploads, deletes } = await prepareQueueOperations(context, paths);
		if (uploads.length > 0) {
			await uploadPendingFiles(context, uploads, completedQueueKeys, uploadConcurrency);
		}

		if (deletes.length > 0) {
			const failures = await deletePendingFiles(context, deletes, completedQueueKeys);
			if (failures.length > 0) {
				await context.localManifest.save();
				clearCompletedRevisions(context, completedQueueKeys, revisionSnapshot);
				context.updateState({
					status: 'error',
					lastError: failures.map(failure => `${failure.path}: ${failure.error}`).join('; '),
					pendingChanges: context.pendingPaths.size,
				});
				return;
			}
		}

		await context.localManifest.save();
		clearCompletedRevisions(context, completedQueueKeys, revisionSnapshot);
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
			if (isRetryableSyncError(error)) {
				for (const path of paths) {
					context.pendingPaths.add(path);
				}
			}
			context.updateState({
				status: 'error',
				lastError: errorMessage(error),
				pendingChanges: context.pendingPaths.size,
			});
		}
	} finally {
		context.inFlightPaths.clear();
		if (!context.isDestroyed() && context.pendingPaths.size > 0) {
			context.triggerDebouncedSync();
		}
	}
}
