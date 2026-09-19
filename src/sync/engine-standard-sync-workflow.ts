import {
	createEmptySyncResult,
	finalizeSyncResult,
	hasUnresolvedConflict,
	recordResolvedRace,
} from './sync-result';
import {
	PREPARE_CONCURRENCY,
} from './engine-constants';
import { uploadFullSyncPlan, type FullSyncUploadContext } from './engine-full-sync-upload';
import { createLogger, errorMessage } from '../plugin/logger';
import type { FileDiff, SyncResult, SyncState } from './types';
import type { FileEntry } from '../protocol/sync-types';
import { getPathEntry } from '../protocol/path-record';
import type { DownloadRequest } from './transfer-download';
import type { DiffApplyOutcome } from './transfer-types';
import {
	completeWorkflowResult,
	getStartFailureResult,
	handleWorkflowError,
	type FullSyncPlan,
	type RemoteManifest,
	type SyncStatus,
} from './engine-workflow-shared';

const logger = createLogger('SyncEngine');

export interface SyncWorkflowContext extends FullSyncUploadContext {
  finishInitialSetup?(): Promise<void>;
  tryInitialImport?(result: SyncResult, progress?: (current: number, total: number) => void): Promise<SyncResult | null>;
	apiConfigured(): boolean;
	recoverUploads(): Promise<void>;
	getStatus(): SyncStatus;
	updateState(updates: Partial<SyncState>): void;
	getManifest(): Promise<RemoteManifest>;
	incrementalSync(
		progressCallback?: (current: number, total: number) => void
	): Promise<SyncResult | null>;
	isAbortError(error: unknown): boolean;
	throwIfDestroyed(): void;
	createFullSyncPlan(
		remoteFiles: Record<string, FileEntry>,
		concurrency: number
	): Promise<FullSyncPlan>;
	processDiff(
		diff: FileDiff,
		localFiles: Record<string, FileEntry>,
		result: SyncResult
	): Promise<DiffApplyOutcome>;
	parallelDownloadAndSaveFiles(requests: DownloadRequest[], result: SyncResult, onProcessed?: () => void): Promise<void>;
	getLocalManifestEntry(path: string): FileEntry | undefined;
	setLocalManifestEntry(path: string, entry: FileEntry): void;
	saveLocalManifest(): Promise<void>;
	setLastSync(value: string): void;
	setLastSeq(value: number): void;
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

	try {
		context.updateState({ work: { phase: 'recovering' } });
		await context.recoverUploads();
    const imported = await context.tryInitialImport?.(result, progressCallback);
    if (imported) {
      result = imported;
      if (!imported.errors.length) await context.finishInitialSetup?.();
      completeWorkflowResult(context, imported, { errorFallback: 'Initial sync completed with errors' });
      return imported;
    }
		context.updateState({ work: { phase: 'server' } });
		context.throwIfDestroyed();
		const incrementalResult = await context.incrementalSync(progressCallback);
		if (incrementalResult) {
			result = incrementalResult;
			if (!result.errors.length) await context.finishInitialSetup?.();
			completeWorkflowResult(context, incrementalResult, {
				errorFallback: 'Incremental sync completed with errors',
			});
			return incrementalResult;
		}
	} catch (error) {
		if (context.isAbortError(error)) {
			logger.info('Incremental sync aborted');
			return result;
		}
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
		const plan = await context.createFullSyncPlan(remoteManifest.files, PREPARE_CONCURRENCY);

		const {
			localFiles,
			diffs,
			uploadDiffs,
			downloadDiffs,
			remainingDiffs,
			errors,
		} = plan;
		result.errors.push(...errors);
		for (const [path, entry] of Object.entries(localFiles)) {
			if (entry.hash === getPathEntry(remoteManifest.files, path)?.hash) result.settledPaths.push(path);
		}

		const conflictDiffs = diffs.filter(diff => diff.action === 'conflict');
		const deleteDiffs = diffs.filter(diff => diff.action === 'delete');
		logger.info(
			`Full sync diffs: ${uploadDiffs.length} upload, ${downloadDiffs.length} download, ${conflictDiffs.length} conflict, ${deleteDiffs.length} delete`,
		);

		const total = diffs.length;
		let current = 0;
		progressCallback?.(current, total);

		if (uploadDiffs.length > 0) {
			context.updateState({ work: { phase: 'preparing' } });
			await uploadFullSyncPlan(context, uploadDiffs, localFiles, result, () => {
				current++;
				progressCallback?.(current, total);
			});
		}

		context.throwIfDestroyed();

		if (downloadDiffs.length > 0) {
			const downloadRequests: DownloadRequest[] = [];
			for (const diff of downloadDiffs) {
				if (!diff.remoteHash) {
					result.errors.push(`${diff.path}: remote hash missing from download plan`);
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
			for (const diff of downloadDiffs) {
				if (
					diff.cause === 'local-deleted'
					&& result.downloadedPaths.includes(diff.path)
					&& !hasUnresolvedConflict(result, diff.path)
				) {
					recordResolvedRace(result, diff.path, 'kept-remote-edit');
				}
				if (result.downloadedPaths.includes(diff.path)) {
					const manifestEntry = context.getLocalManifestEntry(diff.path);
					if (manifestEntry) localFiles[diff.path] = manifestEntry;
				}
			}
			current = beforeDownloads + downloadDiffs.length;
			progressCallback?.(current, total);
		}

		context.throwIfDestroyed();

		if (remainingDiffs.length) context.updateState({ work: { phase: 'applying' } });
		for (const diff of remainingDiffs) {
			try {
				if (diff.action === 'delete' && result.errors.length > 0) throw new Error('Remote deletion deferred until uploads and reconciliation finish successfully');
				const outcome = await context.processDiff(diff, localFiles, result);
				if (outcome.status === 'deferred') {
					result.errors.push(`${diff.path}: ${outcome.reason}`);
				}
			} catch (error) {
				result.errors.push(`${diff.path}: ${errorMessage(error)}`);
			}
			current++;
			progressCallback?.(current, total);
		}

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
		if (!result.errors.length) await context.finishInitialSetup?.();
		completeWorkflowResult(context, result, {
			errorFallback: 'Full sync completed with errors',
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
