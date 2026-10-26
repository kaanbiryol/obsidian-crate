import { pendingChangeKey, decodePendingChange } from '../pending/pending-change';
import { uploadPipelined } from '../transfer/upload-pipeline';
import { createAbortError } from '../abort';
import { createLogger } from '../logger';
import { isAbortError } from '../abort';
import { isQueueTerminalFailure, isRetryableSyncError, isVersionConflict } from '../failures';
import type { QueueDeleteCandidate, QueueDeleteFailure, QueueFlushBatch, QueueFlushContext, QueueUploadFailure } from './flush-types';
import { createEmptySyncResult, finalizeSyncResult } from '../sync-result';
import type { SyncResult } from '../types';
import { syncErrorIssues, formatSyncIssue, SkippedFileError, skippedFileIssue, withSyncFileContext } from '../issues';
import type { SyncIssue } from '../types';
import { HttpError } from '../worker-api/http';
import { beginSyncAttempt, completeTransferResult, completeWorkflowResult, handleWorkflowError } from '../sync-outcome';

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

async function deletePendingFiles(
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

	let batch!: QueueFlushBatch;
	const startFailure = beginSyncAttempt({
		apiConfigured: () => context.api.isConfigured(),
		getStatus: () => context.currentStatus(),
		updateState: updates => context.updateState(updates),
	}, () => {
		batch = context.beginBatch();
		logger.info(`Processing ${batch.paths.length} pending changes`);
		return { pendingChanges: context.getPendingPathCount() };
	});
	if (startFailure) {
		context.updateState({ pendingChanges: context.getPendingPathCount() });
		if (context.currentStatus() === 'syncing') context.triggerDebouncedSync();
		return;
	}

	const { paths } = batch;
	const changes = paths.map(decodePendingChange);
	const uploadPaths = changes.filter(change => change.kind === 'upload').map(change => change.path);
	const deletedPaths = changes.filter(change => change.kind === 'delete').map(change => change.path);
	const completedQueueKeys = new Set<string>();
	const reconciliationPaths = new Set<string>();
	const skipped: SyncIssue[] = [];
	let hasTerminalFailure = false;
	let flushFailed = false;

	try {
		await context.recoverUploads();
		if (context.isDestroyed()) throw createAbortError('Queue recovery aborted');
		const uploads: Array<{ path: string }> = [];
		const deletes = deletedPaths.flatMap(path => {
			const expectedHash = context.localManifest.getEntry(path)?.hash;
			return expectedHash ? [{ path, expectedHash, expectedRevision: context.localManifest.getEntry(path)?.revision }] : [];
		});
		const failures: Array<{ path: string; error: string; status?: number }> = [];
		let uploadsProcessed = 0;
		// Queue settlement is mode-specific; transfer and acknowledgement are shared.
		const uploadResult = createEmptySyncResult();
		let chunkFailures: QueueUploadFailure[] = [];
		let chunkConflicts: string[] = [];
		try {
			await uploadPipelined(context, uploadPaths, uploadResult, {
				prepare: async path => {
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
				},
				retry: false,
				onFailure: failure => { chunkFailures.push(failure); },
				onVersionConflicts: async paths => { chunkConflicts.push(...paths); },
				beforeChunk: chunk => {
					uploads.push(...chunk.map(upload => ({ path: upload.path })));
					context.updateState({ work: { phase: 'uploading', current: uploadsProcessed, total: uploadPaths.length } });
				},
				onProcessed: count => {
					uploadsProcessed += count;
					context.updateState({ work: { phase: 'uploading', current: uploadsProcessed, total: uploadPaths.length } });
				},
				afterChunk: () => {
					const uploadFailures: QueueUploadFailure[] = [
						...chunkFailures,
						...chunkConflicts.map(path => ({ path, error: 'Remote file changed since it was read', status: 409, code: 'version_conflict' })),
					];
					chunkFailures = [];
					chunkConflicts = [];
					for (const failure of uploadFailures) {
						const key = pendingChangeKey('upload', failure.path);
						batch.requeue([key]);
						if (isVersionConflict(failure.status, failure.code)) reconciliationPaths.add(key);
						if (isQueueTerminalFailure(failure.status, failure.code)) hasTerminalFailure = true;
					}
					failures.push(...uploadFailures);
				},
			});
		} finally {
			// Preserve accepted siblings when another in-flight request is cancelled.
			for (const path of uploadResult.uploadedPaths) completedQueueKeys.add(pendingChangeKey('upload', path));
		}

		if (deletes.length > 0 && failures.length > 0) {
			// Reconciliation runs deletes after the conflicting uploads settle. Without
			// it, held-back deletes would wait for an unrelated event or sync.
			const reconciling = reconciliationPaths.size > 0;
			for (const file of deletes) {
				const key = pendingChangeKey('delete', file.path);
				batch.requeue([key]);
				if (reconciling) reconciliationPaths.add(key);
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
		if (failures.length > 0) {
			flushFailed = true;
			const errors = failures.map(failure => `${failure.path}: ${failure.error}`);
			const issues = [...failures.map(failure => ({ path: failure.path, message: failure.error })), ...skipped];
			batch.release();
			const failed = { ...buildQueueSyncResult(uploads, deletes, completedQueueKeys, errors), issues };
			completeTransferResult(context, failed, failures, {
				errorFallback: FLUSH_FAILURE, errorSummary: errors.join('; '), failureLogPrefix: FLUSH_FAILURE, logger,
				pendingChanges: context.getPendingPathCount(),
			});
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
