import { createDeleteCandidates } from '../transfer/delete';
import { pendingChangeKey } from '../pending/pending-change';
import { recordSyncError } from '../issues';
import { hasUnresolvedConflict, recordResolvedRace } from '../sync-result';
import { PREPARE_CONCURRENCY } from '../transfer/constants';
import { uploadFullSyncPlan } from './full-sync-upload';
import { createLogger } from '../logger';
import type { FileDiff, RemoteManifest, SyncResult } from '../types';
import type { FileEntry, MutationFailure } from '../../protocol/sync-types';
import { getPathEntry } from '../../protocol/path-record';
import { namespaceConflictLookup } from '../namespace-conflicts';
import type { DownloadRequest } from '../transfer/download';
import type { FullSyncPlan } from '../planner/types';
import { completeTransferResult, handleWorkflowError } from '../sync-outcome';
import { applyDiffs } from '../transfer/process';
import type { SyncWorkflowContext } from './standard-sync-workflow';

const logger = createLogger('SyncEngine');

/** Compares the vault with the server manifest and applies every change. The
 * planned baseline entries and the changelog cursor advance only when all of them
 * applied or await review; a file awaiting review keeps its existing baseline. */
export async function runFullSync(
	context: SyncWorkflowContext,
	result: SyncResult,
	recovering: boolean,
	progressCallback?: (current: number, total: number) => void,
): Promise<void> {
	try {
		context.throwIfDestroyed();
		context.updateState({ work: { phase: 'server' } });
		// The local scan and hashing overlap the manifest request.
		const manifestRequest = context.getManifest();
		const remoteFiles = manifestRequest.then(manifest => manifest.files);
		// Raised by the planner or by the await below, whichever comes first.
		void remoteFiles.catch(() => {});
		context.updateState({ work: { phase: 'scanning' } });
		const plan = await context.createFullSyncPlan(remoteFiles, PREPARE_CONCURRENCY, { reuseUnchangedHashes: recovering });
		const remoteManifest = await manifestRequest;

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
		const advance = (count = 1) => { current += count; progressCallback?.(current, total); };
		const failures: MutationFailure[] = [];
		const deleteRemote = async (deletes: Array<Extract<FileDiff, { action: 'delete' }>>) => {
			failures.push(...await context.deleteRemoteFiles(createDeleteCandidates(deletes.map(diff => (
				{ path: diff.path, hash: diff.remoteHash, revision: diff.remoteRevision }
			)), result), result, {
				onProcessed: advance,
			}));
		};
		const applyRemaining = (applied: FileDiff[]) => applyDiffs(context, applied, result, {
			localFiles: () => localFiles,
			onFailure: failure => { failures.push(failure); },
			afterDiff: () => advance(),
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
			failures.push(...await uploadFullSyncPlan(context, uploadDiffs, localFiles, result, () => advance()));
		}

		context.throwIfDestroyed();
		await applyRemaining([...clearing].filter(diff => diff.action === 'delete-local'));

		if (downloadDiffs.length > 0) {
			const beforeDownloads = current;
			await context.parallelDownloadAndSaveFiles(
				downloadRequests(downloadDiffs, remoteManifest, result),
				result,
				() => advance(),
				failure => { failures.push(failure); },
			);
			adoptDownloadedEntries(context, downloadDiffs, localFiles, result);
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
				context.localManifest.setEntry(path, entry);
			}
		}
		context.updateState({ work: { phase: 'saving' } });
		await context.localManifest.save();

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

function downloadRequests(diffs: FullSyncPlan['downloadDiffs'], remoteManifest: RemoteManifest, result: SyncResult): DownloadRequest[] {
	const requests: DownloadRequest[] = [];
	for (const diff of diffs) {
		if (!diff.remoteHash) {
			recordSyncError(result, `remote hash missing from download plan`, diff.path);
			continue;
		}
		requests.push({
			path: diff.path,
			expectedLocalHash: diff.localHash ?? null,
			expectedRemoteHash: diff.remoteHash,
			remoteSize: getPathEntry(remoteManifest.files, diff.path)?.size ?? 0,
		});
	}
	return requests;
}

/** Downloaded files enter the planned baseline as the manifest recorded them. A local
 * delete that lost to a remote edit is reported as a resolved race. */
function adoptDownloadedEntries(context: SyncWorkflowContext, diffs: FullSyncPlan['downloadDiffs'], localFiles: Record<string, FileEntry>, result: SyncResult): void {
	const downloaded = new Set(result.downloadedPaths);
	for (const diff of diffs) {
		if (!downloaded.has(diff.path)) continue;
		if (diff.cause === 'local-deleted' && !hasUnresolvedConflict(result, diff.path)) recordResolvedRace(result, diff.path, 'kept-remote-edit');
		const manifestEntry = context.localManifest.getEntry(diff.path);
		if (manifestEntry) localFiles[diff.path] = manifestEntry;
	}
}
