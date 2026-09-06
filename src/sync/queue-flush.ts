import { prepareUploadChunks } from './transfer-budget';
import { createAbortError } from './abort';
import { createLogger, errorMessage } from '../plugin/logger';
import { isAbortError } from './abort';
import { isRetryableSyncError } from './engine-utils';
import { deletePendingFiles } from './queue-delete';
import type { QueueFlushContext } from './queue-flush-types';
import { uploadPendingFiles } from './queue-upload';
import { isQueueTerminalFailure, isQueueVersionConflict } from './queue-failure';
import { HttpError } from './api';
import { createEmptySyncResult } from './sync-result';
import type { SyncResult } from './types';

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

function buildQueueSyncResult(
	uploads: Array<{ path: string }>,
	deletes: Array<{ path: string }>,
	completedQueueKeys: Set<string>,
	errors: string[] = [],
): SyncResult {
	const result = createEmptySyncResult();
	result.uploadedPaths = uploads
		.filter(upload => completedQueueKeys.has(upload.path))
		.map(upload => upload.path);
	result.deletedPaths = deletes
		.filter(file => completedQueueKeys.has(`delete:${file.path}`))
		.map(file => file.path);
	result.uploaded = result.uploadedPaths.length;
	result.deleted = result.deletedPaths.length;
	result.errors.push(...errors);
	result.success = errors.length === 0;
	return result;
}

async function reportFlushResult(context: QueueFlushContext, result: SyncResult): Promise<void> {
	try {
		await context.onFlushResult?.(result);
	} catch (error) {
		logger.error('Failed to record automatic sync activity:', error);
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
		const uploads: Array<{ path: string }> = [];
		const deletes = paths.filter(path => path.startsWith('delete:')).flatMap(key => {
			const path = key.substring(7);
			const expectedHash = context.localManifest.getEntry?.(path)?.hash;
			return expectedHash ? [{ path, expectedHash, expectedRevision: context.localManifest.getEntry?.(path)?.revision }] : [];
		});
		const chunks = prepareUploadChunks(paths.filter(path => !path.startsWith('delete:')), async path => {
			if (context.isDestroyed()) throw createAbortError('Queue preparation aborted');
			return context.prepareUploadFromPath(path);
		});
		const failures: Array<{ path: string; error: string; status?: number }> = [];
		for await (const chunk of chunks) {
			uploads.push(...chunk.map(upload => ({ path: upload.path })));
			const uploadFailures = await uploadPendingFiles(context, chunk, completedQueueKeys, uploadConcurrency);
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
			const errors = failures.map(failure => `${failure.path}: ${failure.error}`);
			context.updateState({
				status: 'error',
				lastError: errors.join('; '),
				pendingChanges: context.pendingPaths.size,
			});
			await reportFlushResult(
				context,
				buildQueueSyncResult(uploads, deletes, completedQueueKeys, errors),
			);
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
		if (didWork) {
			await reportFlushResult(
				context,
				buildQueueSyncResult(uploads, deletes, completedQueueKeys),
			);
		}
	} catch (error) {
		if (isAbortError(error)) {
			for (const path of paths) {
				if (!completedQueueKeys.has(path)) context.pendingPaths.add(path);
			}
			if (!context.isDestroyed()) context.updateState({ status: 'idle', pendingChanges: context.pendingPaths.size });
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
