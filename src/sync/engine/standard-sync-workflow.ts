import { createDeleteCandidates, type DeleteRemoteFiles } from '../transfer/delete';
import { pendingChangeKey } from '../pending/pending-change';
import { recordSyncError } from '../issues';
import {
	createEmptySyncResult,
	finalizeSyncResult,
	hasUnresolvedConflict,
	recordResolvedRace,
} from '../sync-result';
import { PREPARE_CONCURRENCY } from '../transfer/constants';
import { uploadFullSyncPlan, type FullSyncUploadContext } from './full-sync-upload';
import { createLogger } from '../logger';
import type { FileDiff, RemoteManifest, SyncResult, SyncState } from '../types';
import type { FileEntry, MutationFailure } from '../../protocol/sync-types';
import { getPathEntry } from '../../protocol/path-record';
import { namespaceConflictLookup } from '../namespace-conflicts';
import type { DownloadRequest } from '../transfer/download';
import type { DiffApplyOutcome } from '../transfer/types';
import type { FullSyncPlan } from '../planner/types';
import {
	beginSyncAttempt,
	completeTransferResult,
	completeWorkflowResult,
	handleWorkflowError,
	type ReconnectNotice,
	type SyncStatus,
} from '../sync-outcome';
import { applyDiffs } from '../transfer/process';

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
		progressCallback?: (current: number, total: number) => void,
		onFailure?: (failure: MutationFailure) => void,
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
	parallelDownloadAndSaveFiles(requests: DownloadRequest[], result: SyncResult, onProcessed?: () => void, onFailure?: (failure: MutationFailure) => void): Promise<void>;
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
	const startFailure = beginSyncAttempt(context);
	if (startFailure) return startFailure;
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
		const incrementalFailures: MutationFailure[] = [];
		const incrementalResult = await context.incrementalSync(progressCallback, failure => { incrementalFailures.push(failure); });
		if (incrementalResult) {
			result = incrementalResult;
			if (finalizeSyncResult(result)) await context.finishInitialSetup();
			completeTransferResult(context, incrementalResult, incrementalFailures, {
				errorFallback: 'Incremental sync completed with errors',
				failureLogPrefix: 'Incremental sync failed',
				logger,
			});
			return incrementalResult;
		}
	} catch (error) {
		handleWorkflowError(context, result, error, { abortLogMessage: 'Sync recovery aborted', failureLogPrefix: 'Sync recovery failed', logger });
		finalizeSyncResult(result);
		return result;
	}

	logger.info('Running full sync');
	await runFullSync(context, result, recovering, progressCallback);
	finalizeSyncResult(result);
	return result;
}

/** Compares the vault with the server manifest and applies every change. The
 * planned baseline entries and the changelog cursor advance only when all of them
 * applied or await review; a file awaiting review keeps its existing baseline. */
async function runFullSync(
	context: SyncWorkflowContext,
	result: SyncResult,
	recovering: boolean,
	progressCallback?: (current: number, total: number) => void,
): Promise<void> {
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
		} = plan;
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
		const deleteRemote = async (deletes: Array<Extract<FileDiff, { action: 'delete' }>>) => {
			failures.push(...await context.deleteRemoteFiles(createDeleteCandidates(deletes.map(diff => (
				{ path: diff.path, hash: diff.remoteHash, revision: diff.remoteRevision }
			)), result), result, {
				onProcessed: count => { current += count; progressCallback?.(current, total); },
			}));
		};
		const applyRemaining = (applied: FileDiff[]) => applyDiffs(context, applied, result, {
			localFiles: () => localFiles,
			onFailure: failure => { failures.push(failure); },
			afterDiff: () => {
				current++;
				progressCallback?.(current, total);
			},
		});

		// The server cannot store a path beside another in its namespace, as after a
		// case-only or Unicode-only rename, so a remote delete clearing an upload's
		// name runs first. A case-insensitive device likewise removes the local file
		// whose name a download takes before writing it.
		const uploadConflict = namespaceConflictLookup(uploadDiffs.map(diff => diff.path));
		const downloadConflict = namespaceConflictLookup(downloadDiffs.map(diff => diff.path));
		const clearing = new Set(remainingDiffs.filter(diff => (diff.action === 'delete' && uploadConflict(diff.path) !== undefined)
			|| (diff.action === 'delete-local' && downloadConflict(diff.path) !== undefined)));
		await deleteRemote([...clearing].filter(diff => diff.action === 'delete'));

		if (uploadDiffs.length > 0) {
			context.updateState({ work: { phase: 'preparing' } });
			failures.push(...await uploadFullSyncPlan(context, uploadDiffs, localFiles, result, () => {
				current++;
				progressCallback?.(current, total);
			}));
		}

		context.throwIfDestroyed();
		await applyRemaining([...clearing].filter(diff => diff.action === 'delete-local'));

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
				failure => { failures.push(failure); },
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

		const unapplied = remainingDiffs.filter(diff => !clearing.has(diff));
		const remoteDeletes = unapplied.filter(diff => diff.action === 'delete');
		const otherDiffs = unapplied.filter(diff => diff.action !== 'delete');
		if (otherDiffs.length) context.updateState({ work: { phase: 'applying' } });
		await applyRemaining(otherDiffs);

		await deleteRemote(remoteDeletes);
		for (const path of result.deletedPaths) delete localFiles[path];
		// A file awaiting review keeps its baseline, so the next sync finds the conflict again.
		for (const issue of result.issues ?? []) if (issue.code === 'incoming-review' && issue.path) delete localFiles[issue.path];

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
}
