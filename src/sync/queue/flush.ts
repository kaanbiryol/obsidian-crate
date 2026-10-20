import { pendingChangeKey, decodePendingChange } from '../pending/pending-change';
import { pipelineUploadChunks } from '../transfer/budget';
import { createAbortError } from '../abort';
import { createLogger } from '../logger';
import { isAbortError } from '../abort';
import { isQueueTerminalFailure, isRetryableSyncError, isVersionConflict } from '../failures';
import { deletePendingFiles } from './delete';
import type { QueueFlushContext } from './flush-types';
import { uploadPendingFiles } from './upload';
import { createEmptySyncResult, finalizeSyncResult } from '../sync-result';
import type { SyncResult } from '../types';
import { syncErrorIssues, formatSyncIssue, SkippedFileError, skippedFileIssue, withSyncFileContext } from '../issues';
import type { SyncIssue } from '../types';
import { HttpError } from '../worker-api/http';
import { completeWorkflowResult, handleWorkflowError, publishAuthFailure } from '../engine/workflow-shared';

export type { QueueFlushContext } from './flush-types';

const logger = createLogger('SyncQueue');
const FLUSH_FAILURE = 'Queued sync failed';

function buildQueueSyncResult(
	uploads: Array<{ path: string }>,
	deletes: Array<{ path: string }>,
	completedQueueKeys: Set<string>,
	errors: string[] = [],
): SyncResult {
	const result = createEmptySyncResult();
	result.uploadedPaths = uploads
		.filter(upload => completedQueueKeys.has(pendingChangeKey('upload', upload.path)))
		.map(upload => upload.path);
	result.deletedPaths = deletes
		.filter(file => completedQueueKeys.has(pendingChangeKey('delete', file.path)))
		.map(file => file.path);
	result.uploaded = result.uploadedPaths.length;
	result.deleted = result.deletedPaths.length;
	result.errors.push(...errors);
	finalizeSyncResult(result);
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
): Promise<void> {
	if (context.isDestroyed()) return;

	if (context.getPendingPathCount() === 0) {
		context.updateState({ pendingChanges: 0 });
		return;
	}
	if (context.currentStatus() === 'syncing') {
		context.updateState({ pendingChanges: context.getPendingPathCount() });
		context.triggerDebouncedSync();
		return;
	}
	if (!context.api.isConfigured()) {
		context.updateState({ pendingChanges: context.getPendingPathCount() });
		return;
	}

	const batch = context.beginBatch();
	const { paths } = batch;
	const changes = paths.map(decodePendingChange);
	const uploadPaths = changes.filter(change => change.kind === 'upload').map(change => change.path);
	const deletedPaths = changes.filter(change => change.kind === 'delete').map(change => change.path);
	const completedQueueKeys = new Set<string>();
	const reconciliationPaths = new Set<string>();
	const skipped: SyncIssue[] = [];
	let hasTerminalFailure = false;
	let flushFailed = false;

	logger.info(`Processing ${paths.length} pending changes`);
	context.updateState({ status: 'syncing', pendingChanges: context.getPendingPathCount() });

	try {
		await context.recoverUploads();
		if (context.isDestroyed()) throw createAbortError('Queue recovery aborted');
		const uploads: Array<{ path: string }> = [];
		const deletes = deletedPaths.flatMap(path => {
			const expectedHash = context.localManifest.getEntry(path)?.hash;
			return expectedHash ? [{ path, expectedHash, expectedRevision: context.localManifest.getEntry(path)?.revision }] : [];
		});
		const chunks = pipelineUploadChunks(uploadPaths, async path => {
			if (context.isDestroyed()) throw createAbortError('Queue preparation aborted');
			try { return await withSyncFileContext(path, () => context.prepareUploadFromPath(path)); }
			catch (error) {
				if (!(error instanceof SkippedFileError)) throw error;
				// Settle a skipped file rather than failing its batch; a later edit
				// queues it again and is reported the same way.
				completedQueueKeys.add(pendingChangeKey('upload', path));
				skipped.push(skippedFileIssue(path));
				return null;
			}
		});
		const failures: Array<{ path: string; error: string; status?: number }> = [];
		let uploadsProcessed = 0;
		for await (const chunk of chunks) {
			uploads.push(...chunk.map(upload => ({ path: upload.path })));
			context.updateState({ work: { phase: 'uploading', current: uploadsProcessed, total: uploadPaths.length } });
			const uploadFailures = await uploadPendingFiles(context, chunk, completedQueueKeys, count => {
				uploadsProcessed += count;
				context.updateState({ work: { phase: 'uploading', current: uploadsProcessed, total: uploadPaths.length } });
			});
			for (const failure of uploadFailures) {
				const key = pendingChangeKey('upload', failure.path);
				batch.requeue([key]);
				if (isVersionConflict(failure.status, failure.code)) reconciliationPaths.add(key);
				if (isQueueTerminalFailure(failure.status, failure.code)) hasTerminalFailure = true;
			}
			failures.push(...uploadFailures);
		}

		if (deletes.length > 0 && failures.length > 0) {
			for (const file of deletes) {
				batch.requeue([pendingChangeKey('delete', file.path)]);
				failures.push({ path: file.path, error: 'Remote deletion deferred until uploads finish successfully' });
			}
		}
		if (deletes.length > 0 && failures.length === 0) {
			const deleteResult = await deletePendingFiles(context, deletes, completedQueueKeys);
			failures.push(...deleteResult.failures);
			batch.requeue(deleteResult.failures.map(failure => pendingChangeKey('delete', failure.path)));
			for (const path of deleteResult.reconciliationPaths) reconciliationPaths.add(path);
			if (deleteResult.hasTerminalFailure) hasTerminalFailure = true;
		}

		context.updateState({ work: { phase: 'saving' } });
		await context.localManifest.save();
		batch.settle(completedQueueKeys);
		if (failures.length > 0) {
			flushFailed = true;
			const errors = failures.map(failure => `${failure.path}: ${failure.error}`);
			const issues = [...failures.map(failure => ({ path: failure.path, message: failure.error })), ...skipped];
			batch.release();
			const failed = { ...buildQueueSyncResult(uploads, deletes, completedQueueKeys, errors), issues };
			const pendingChanges = context.getPendingPathCount();
			// Transfers record a rejected request per file; one revoked token fails them all.
			if (failures.some(failure => failure.status === 401)) {
				publishAuthFailure(context, failed, { failureLogPrefix: FLUSH_FAILURE, logger, pendingChanges });
			} else {
				completeWorkflowResult(context, failed, { errorFallback: FLUSH_FAILURE, errorSummary: errors.join('; '), pendingChanges });
			}
			await reportFlushResult(context, failed);
			if (reconciliationPaths.size > 0) context.requestReconciliation([...reconciliationPaths]);
			return;
		}

		batch.release();
		context.flushSucceeded?.();
		const didWork = uploads.length > 0 || deletes.length > 0 || skipped.length > 0;
		await context.finishInitialSetup();
		if (!didWork) {
			context.updateState({ status: 'idle', pendingChanges: context.getPendingPathCount() });
			return;
		}
		const synced = { ...buildQueueSyncResult(uploads, deletes, completedQueueKeys), ...(skipped.length ? { issues: skipped } : {}) };
		completeWorkflowResult(context, synced, { errorFallback: FLUSH_FAILURE, pendingChanges: context.getPendingPathCount() });
		await reportFlushResult(context, synced);
	} catch (error) {
		if (isAbortError(error)) {
			batch.requeue(paths.filter(path => !completedQueueKeys.has(path)));
			batch.settle(completedQueueKeys);
			batch.release();
			if (!context.isDestroyed()) context.updateState({ status: 'idle', pendingChanges: context.getPendingPathCount() });
			logger.info('Queue processing aborted');
		} else {
			flushFailed = true;
			const retryable = isRetryableSyncError(error);
			batch.requeue(paths.filter(path => !completedQueueKeys.has(path)));
			if (!retryable) {
				if (error instanceof HttpError && isVersionConflict(error.status, error.code)) {
					for (const path of paths) {
						if (!completedQueueKeys.has(path)) reconciliationPaths.add(path);
					}
				} else {
					hasTerminalFailure = true;
				}
			}
			batch.release();
			const failed = buildQueueSyncResult(
				uploadPaths.map(path => ({ path })),
				deletedPaths.map(path => ({ path })),
				completedQueueKeys,
			);
			handleWorkflowError(context, failed, error, {
				abortLogMessage: 'Queue processing aborted',
				failureLogPrefix: FLUSH_FAILURE,
				logger,
				errorSummary: syncErrorIssues(error).map(formatSyncIssue).join('; '),
				pendingChanges: context.getPendingPathCount(),
			});
			finalizeSyncResult(failed);
			await reportFlushResult(context, failed);
			if (reconciliationPaths.size > 0) context.requestReconciliation([...reconciliationPaths]);
		}
	} finally {
		batch.release();
		if (
			!context.isDestroyed()
			&& context.getPendingPathCount() > 0
			&& reconciliationPaths.size === 0
			&& !hasTerminalFailure
		) {
			if (flushFailed && context.retryAfterFailure) context.retryAfterFailure();
			else context.triggerDebouncedSync();
		}
	}
}
