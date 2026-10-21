import type { DeleteRemoteFiles } from '../transfer/delete';
import { pendingChangeKey } from '../pending/pending-change';
import { recordSyncError } from '../issues';
import {
	createEmptySyncResult,
	finalizeSyncResult,
	hasUnresolvedConflict,
	recordResolvedRace,
} from '../sync-result';
import {
	PREPARE_CONCURRENCY,
} from './constants';
import { uploadFullSyncPlan, type FullSyncUploadContext } from './full-sync-upload';
import { createLogger, errorMessage } from '../logger';
import type { FileDiff, SyncResult, SyncState } from '../types';
import type { FileEntry, MutationFailure } from '../../protocol/sync-types';
import { getPathEntry } from '../../protocol/path-record';
import type { DownloadRequest } from '../transfer/download';
import type { DiffApplyOutcome } from '../transfer/types';
import type { FullSyncPlan } from '../planner/types';
import {
	completeTransferResult,
	completeWorkflowResult,
	getStartFailureResult,
	handleWorkflowError,
	type ReconnectNotice,
	type RemoteManifest,
	type SyncStatus,
} from './workflow-shared';
import { isAbortError } from '../abort';

const logger = createLogger('SyncEngine');

export interface SyncWorkflowContext extends FullSyncUploadContext {
	deleteRemoteFiles: DeleteRemoteFiles;
  finishInitialSetup(): Promise<void>;
  tryInitialImport?(result: SyncResult, progress?: (current: number, total: number) => void): Promise<SyncResult | null>;
	apiConfigured(): boolean;
	recoverUploads(): Promise<void>;
	getStatus(): SyncStatus;
	updateState(updates: Partial<SyncState>): void;
	getManifest(): Promise<RemoteManifest>;
	incrementalSync(
		progressCallback?: (current: number, total: number) => void
	): Promise<SyncResult | null>;
	throwIfDestroyed(): void;
	createFullSyncPlan(
		remoteFiles: Record<string, FileEntry>,
		concurrency: number,
		options?: { reuseUnchangedHashes?: boolean },
	): Promise<FullSyncPlan>;
	/** True when this device has synced before and holds a changelog cursor. */
	hasSyncCursor?(): boolean;
	processDiff(
		diff: FileDiff,
		localFiles: Record<string, FileEntry>,
		result: SyncResult
	): Promise<DiffApplyOutcome>;
	parallelDownloadAndSaveFiles(requests: DownloadRequest[], result: SyncResult, onProcessed?: () => void): Promise<void>;
	getLocalManifestEntry(path: string): Readonly<FileEntry> | undefined;
	setLocalManifestEntry(path: string, entry: FileEntry): void;
	saveLocalManifest(): Promise<void>;
	setLastSync(value: string): void;
	setLastSeq(value: number): void;
	reconnectNotice: ReconnectNotice;
}

export async function runSyncWorkflow(
	context: SyncWorkflowContext,
	progressCallback?: (current: number, total: number) => void
): Promise<SyncResult> {
	const startFailure = getStartFailureResult(context);
	if (startFailure) return startFailure;

	context.updateState({ status: 'syncing' });
	logger.info('Sync started');
	let result = createEmptySyncResult();
	let recovering = false;

	try {
		context.updateState({ work: { phase: 'recovering' } });
		await context.recoverUploads();
    const imported = await context.tryInitialImport?.(result, progressCallback);
    if (imported) {
      result = imported;
      if (finalizeSyncResult(imported)) await context.finishInitialSetup();
      completeWorkflowResult(context, imported, { errorFallback: 'Initial sync completed with errors' });
      return imported;
    }
		context.updateState({ work: { phase: 'server' } });
		context.throwIfDestroyed();
		recovering = context.hasSyncCursor?.() ?? false;
		const incrementalResult = await context.incrementalSync(progressCallback);
		if (incrementalResult) {
			result = incrementalResult;
			if (finalizeSyncResult(result)) await context.finishInitialSetup();
			completeWorkflowResult(context, incrementalResult, {
				errorFallback: 'Incremental sync completed with errors',
			});
			return incrementalResult;
		}
	} catch (error) {
		handleWorkflowError(context, result, error, { abortLogMessage: 'Sync recovery aborted', failureLogPrefix: 'Sync recovery failed', logger });
		finalizeSyncResult(result);
		return result;
	}

	logger.info('Running full sync');

	try {
		context.throwIfDestroyed();
		context.updateState({ work: { phase: 'server' } });
		const remoteManifest = await context.getManifest();
		context.updateState({ work: { phase: 'scanning' } });
		const plan = await context.createFullSyncPlan(remoteManifest.files, PREPARE_CONCURRENCY, { reuseUnchangedHashes: recovering });

		const {
			localFiles,
			diffs,
			uploadDiffs,
			downloadDiffs,
			remainingDiffs,
			errors,
		} = plan;
		result.errors.push(...errors);
		if (plan.issues?.length) (result.issues ??= []).push(...plan.issues);
		for (const [path, entry] of Object.entries(localFiles)) {
			if (entry.hash === getPathEntry(remoteManifest.files, path)?.hash) result.settledPaths.push(pendingChangeKey('upload', path));
		}

		const conflictDiffs = diffs.filter(diff => diff.action === 'conflict');
		const deleteDiffs = diffs.filter(diff => diff.action === 'delete');
		logger.info(
			`Full sync diffs: ${uploadDiffs.length} upload, ${downloadDiffs.length} download, ${conflictDiffs.length} conflict, ${deleteDiffs.length} delete`,
		);

		const total = diffs.length;
		let current = 0;
		progressCallback?.(current, total);
		const failures: MutationFailure[] = [];

		if (uploadDiffs.length > 0) {
			context.updateState({ work: { phase: 'preparing' } });
			failures.push(...await uploadFullSyncPlan(context, uploadDiffs, localFiles, result, () => {
				current++;
				progressCallback?.(current, total);
			}));
		}

		context.throwIfDestroyed();

		if (downloadDiffs.length > 0) {
			const downloadRequests: DownloadRequest[] = [];
			for (const diff of downloadDiffs) {
				if (!diff.remoteHash) {
					recordSyncError(result, `remote hash missing from download plan`, diff.path);
					continue;
				}
				downloadRequests.push({
					path: diff.path,
					expectedLocalHash: diff.localHash ?? null,
					expectedRemoteHash: diff.remoteHash,
					remoteSize: getPathEntry(remoteManifest.files, diff.path)?.size ?? 0,
				});
			}
			const beforeDownloads = current;
			let downloadsProcessed = 0;
			context.updateState({ work: { phase: 'downloading', current: downloadsProcessed, total: downloadRequests.length } });
			await context.parallelDownloadAndSaveFiles(
				downloadRequests,
				result,
				() => {
					downloadsProcessed++;
					current++;
					context.updateState({ work: { phase: 'downloading', current: downloadsProcessed, total: downloadRequests.length } });
					progressCallback?.(current, total);
				},
			);
			const downloaded = new Set(result.downloadedPaths);
			for (const diff of downloadDiffs) {
				if (
					diff.cause === 'local-deleted'
					&& downloaded.has(diff.path)
					&& !hasUnresolvedConflict(result, diff.path)
				) {
					recordResolvedRace(result, diff.path, 'kept-remote-edit');
				}
				if (downloaded.has(diff.path)) {
					const manifestEntry = context.getLocalManifestEntry(diff.path);
					if (manifestEntry) localFiles[diff.path] = manifestEntry;
				}
			}
			current = beforeDownloads + downloadDiffs.length;
			progressCallback?.(current, total);
		}

		context.throwIfDestroyed();

		const remoteDeletes = remainingDiffs.filter(diff => diff.action === 'delete');
		const otherDiffs = remainingDiffs.filter(diff => diff.action !== 'delete');
		if (otherDiffs.length) context.updateState({ work: { phase: 'applying' } });
		for (const diff of otherDiffs) {
			try {
				const outcome = await context.processDiff(diff, localFiles, result);
				if (outcome.status === 'deferred') {
					recordSyncError(result, `${outcome.reason}`, diff.path);
				}
			} catch (error) {
				if (isAbortError(error)) throw error;
				recordSyncError(result, `${errorMessage(error)}`, diff.path);
			}
			current++;
			progressCallback?.(current, total);
		}

		failures.push(...await context.deleteRemoteFiles(remoteDeletes.flatMap(diff => {
			if (!diff.remoteHash) { recordSyncError(result, 'Missing remote version for delete', diff.path); return []; }
			return [{ path: diff.path, expectedHash: diff.remoteHash, expectedRevision: diff.remoteRevision }];
		}), result, {
			onProcessed: count => { current += count; progressCallback?.(current, total); },
		}));
		for (const path of result.deletedPaths) delete localFiles[path];

		if (result.errors.length === 0) {
			for (const [path, entry] of Object.entries(localFiles)) {
				context.setLocalManifestEntry(path, entry);
			}
		}
		context.updateState({ work: { phase: 'saving' } });
		await context.saveLocalManifest();

		if (
			result.errors.length === 0
			&& remoteManifest.lastSeq !== undefined
			&& remoteManifest.lastSeq > 0
		) {
			context.setLastSeq(remoteManifest.lastSeq);
		}
		if (!result.errors.length) await context.finishInitialSetup();
		completeTransferResult(context, result, failures, {
			errorFallback: 'Full sync completed with errors',
			failureLogPrefix: 'Full sync failed',
			logger,
		});

		logger.info(
			`Full sync completed: ${result.uploaded} up, ${result.downloaded} down, ${result.merged} merged, ${result.conflicts.length} conflicts`,
		);
	} catch (error) {
		handleWorkflowError(context, result, error, {
			abortLogMessage: 'Full sync aborted',
			failureLogPrefix: 'Full sync failed',
			logger,
			logGenericError: true,
		});
	}

	finalizeSyncResult(result);
	return result;
}
