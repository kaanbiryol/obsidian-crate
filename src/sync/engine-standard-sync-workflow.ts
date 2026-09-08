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
	apiConfigured(): boolean;
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
	parallelDownloadAndSaveFiles(requests: DownloadRequest[], result: SyncResult): Promise<void>;
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

	try {
		const incrementalResult = await context.incrementalSync(progressCallback);
		if (incrementalResult) {
			completeWorkflowResult(context, incrementalResult, {
				errorFallback: 'Incremental sync completed with errors',
			});
			return incrementalResult;
		}
	} catch (error) {
		if (context.isAbortError(error)) {
			logger.info('Incremental sync aborted');
			return createEmptySyncResult();
		}
		throw error;
	}

	logger.info('Running full sync');

	const result = createEmptySyncResult();

	try {
		context.throwIfDestroyed();
		const remoteManifest = await context.getManifest();
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

		const conflictDiffs = diffs.filter(diff => diff.action === 'conflict');
		const deleteDiffs = diffs.filter(diff => diff.action === 'delete');
		logger.info(
			`Full sync diffs: ${uploadDiffs.length} upload, ${downloadDiffs.length} download, ${conflictDiffs.length} conflict, ${deleteDiffs.length} delete`,
		);

		const total = diffs.length;
		let current = 0;

		if (uploadDiffs.length > 0) {
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
			await context.parallelDownloadAndSaveFiles(
				downloadRequests,
				result,
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
			current += downloadDiffs.length;
			progressCallback?.(current, total);
		}

		context.throwIfDestroyed();

		for (const diff of remainingDiffs) {
			try {
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
		await context.saveLocalManifest();

		if (
			result.errors.length === 0
			&& remoteManifest.lastSeq !== undefined
			&& remoteManifest.lastSeq > 0
		) {
			context.setLastSeq(remoteManifest.lastSeq);
		}
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
