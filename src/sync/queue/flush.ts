import { pendingChangeKey, decodePendingChange } from '../pending/pending-change';
import { uploadPipelined } from '../transfer/upload-pipeline';
import { createAbortError } from '../abort';
import { createLogger } from '../logger';
import { isAbortError } from '../abort';
import { isQueueTerminalFailure, isRetryableSyncError, isVersionConflict } from '../failures';
import { createEmptySyncResult, finalizeSyncResult } from '../sync-result';
import { syncErrorIssues, formatSyncIssue, SkippedFileError, skippedFileIssue, withSyncFileContext } from '../issues';
import { HttpError } from '../worker-api/http';
import { beginSyncAttempt, completeTransferResult, completeWorkflowResult, handleWorkflowError } from '../sync-outcome';
import type { UploadPreparedFilesOptions } from '../transfer/upload';
import type { DeleteRemoteFiles } from '../transfer/delete';
import type { ConditionalDeleteCandidate } from '../transfer/delete-batches';
import type { FileEntry, MutationFailure } from '../../protocol/sync-types';
import type { PreparedUpload, SyncIssue, SyncResult, SyncState } from '../types';
import type { ReconnectNotice } from '../sync-outcome';

interface QueueApi {
	isConfigured(): boolean;
}

interface QueueManifest {
	getEntry(path: string): Readonly<FileEntry> | undefined;
	save(): Promise<void>;
}

type QueueDeleteCandidate = ConditionalDeleteCandidate;
type QueueDeleteFailure = MutationFailure;

interface QueueUploadFailure {
	code?: string;
	path: string;
	error: string;
	status?: number;
}

export interface QueueFlushBatch {
	readonly paths: readonly string[];
	requeue(keys: Iterable<string>): void;
	release(): void;
}

export interface QueueFlushContext {
	finishInitialSetup(): Promise<void>;
	uploadPreparedFiles(prepared: PreparedUpload[], result: SyncResult, options: UploadPreparedFilesOptions): Promise<void>;
	deleteRemoteFiles: DeleteRemoteFiles;
	recoverUploads(): Promise<void>;
	getPendingPathCount(): number;
	beginBatch(): QueueFlushBatch;
	api: QueueApi;
	localManifest: QueueManifest;
	updateState(updates: Partial<SyncState>): void;
	/** Persists the time of a successful flush, as every other sync path does. */
	setLastSync(value: string): void;
	reconnectNotice: ReconnectNotice;
	isDestroyed(): boolean;
	currentStatus(): SyncState['status'];
	prepareUploadFromPath(path: string): Promise<PreparedUpload | null>;
	triggerDebouncedSync(): void;
	/** Schedule the next attempt after a failed flush, backing off while it keeps failing. */
	retryAfterFailure?(): void;
	/** Reset the failure backoff after a flush succeeds. */
	flushSucceeded?(): void;
	requestReconciliation(queueKeys: string[]): void;
	onFlushResult?(result: SyncResult): void | Promise<void>;
}

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

/** What one flush settled so far, shared by its upload and delete phases. */
interface FlushState {
	completedQueueKeys: Set<string>;
	reconciliationPaths: Set<string>;
	skipped: SyncIssue[];
	hasTerminalFailure: boolean;
}

/** A version conflict goes to reconciliation; a terminal failure stops automatic retries. */
function routeFailure(state: FlushState, key: string, failure: { status?: number; code?: string }): void {
	if (isVersionConflict(failure.status, failure.code)) state.reconciliationPaths.add(key);
	if (isQueueTerminalFailure(failure.status, failure.code)) state.hasTerminalFailure = true;
}

async function deletePendingFiles(
	context: QueueFlushContext,
	deletes: QueueDeleteCandidate[],
	state: FlushState,
): Promise<QueueDeleteFailure[]> {
	const result = createEmptySyncResult();
	let failures: QueueDeleteFailure[];
	try {
		failures = await context.deleteRemoteFiles(deletes, result);
	} finally {
		for (const path of result.deletedPaths) state.completedQueueKeys.add(pendingChangeKey('delete', path));
	}
	for (const failure of failures) routeFailure(state, pendingChangeKey('delete', failure.path), failure);
	return failures;
}

/** Uploads the batch's files in pipelined chunks. Failed files return to the queue;
 * skipped files settle so a later edit queues them again. */
async function uploadQueuedChanges(
	context: QueueFlushContext,
	batch: QueueFlushBatch,
	uploadPaths: string[],
	state: FlushState,
): Promise<{ uploads: Array<{ path: string }>; failures: QueueUploadFailure[] }> {
	const uploads: Array<{ path: string }> = [];
	const failures: QueueUploadFailure[] = [];
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
					state.completedQueueKeys.add(pendingChangeKey('upload', path));
					state.skipped.push(skippedFileIssue(path));
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
					routeFailure(state, key, failure);
				}
				failures.push(...uploadFailures);
			},
		});
	} finally {
		// Preserve accepted siblings when another in-flight request is cancelled.
		for (const path of uploadResult.uploadedPaths) state.completedQueueKeys.add(pendingChangeKey('upload', path));
	}
	return { uploads, failures };
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
	const state: FlushState = { completedQueueKeys: new Set(), reconciliationPaths: new Set(), skipped: [], hasTerminalFailure: false };
	const { completedQueueKeys, reconciliationPaths, skipped } = state;
	let flushFailed = false;

	try {
		await context.recoverUploads();
		if (context.isDestroyed()) throw createAbortError('Queue recovery aborted');
		const deletes = deletedPaths.flatMap(path => {
			const expectedHash = context.localManifest.getEntry(path)?.hash;
			return expectedHash ? [{ path, expectedHash, expectedRevision: context.localManifest.getEntry(path)?.revision }] : [];
		});
		const { uploads, failures: uploadFailures } = await uploadQueuedChanges(context, batch, uploadPaths, state);
		const failures: Array<{ path: string; error: string; status?: number }> = [...uploadFailures];

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
			const deleteFailures = await deletePendingFiles(context, deletes, state);
			failures.push(...deleteFailures);
			batch.requeue(deleteFailures.map(failure => pendingChangeKey('delete', failure.path)));
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
					state.hasTerminalFailure = true;
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
			&& !state.hasTerminalFailure
		) {
			if (flushFailed && context.retryAfterFailure) context.retryAfterFailure();
			else context.triggerDebouncedSync();
		}
	}
}
