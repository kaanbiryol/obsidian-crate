import { pendingChangeKey } from '../pending/pending-change';
import { recordSyncError, skippedFileIssue } from '../issues';
import { uploadPipelined } from '../transfer/upload-pipeline';
import { applyDiffs } from '../transfer/process';
import { createDeleteCandidates, deleteRemoteFiles } from '../transfer/delete';
import { isAbortError } from "../abort";
import { fileFailure, isTransientSyncFailure } from "../failures";
import type { IncrementalSyncPlannerContext } from "./types";
import { cancelSyncResult, createEmptySyncResult, finalizeSyncResult, hasUnresolvedConflict, recordResolvedRace } from "../sync-result";
import { createLogger } from "../logger";
import { errorMessage } from "../../platform/logger";
import type { FileEntry, MutationFailure } from '../../protocol/sync-types';
import type { SyncResult } from '../types';
import { reconcileIncrementalRemoteChanges } from './incremental-remote-reconciliation';
import { createPathRecord } from '../../protocol/path-record';
import { readIncrementalChangelog } from './incremental-changelog';

const logger = createLogger("SyncPlanner");

export async function runIncrementalSync(
	context: IncrementalSyncPlannerContext,
	options: {
		progressCallback?: (current: number, total: number) => void;
		/** Receives each file's failure with its HTTP status, so the caller can classify the result. */
		onFailure?: (failure: MutationFailure) => void;
	},
): Promise<SyncResult | null> {
	if (context.settings.lastSeq <= 0) {
		return null;
	}

	const result = createEmptySyncResult();
	try {
		context.reportWork?.({ phase: 'server' });
		const changelog = await readIncrementalChangelog(context.files, context.settings.lastSeq, () => context.throwIfDestroyed());
		if (!changelog) {
			logger.warn("Changelog cursor expired - pruned entries detected, falling back to full sync");
			return null;
		}
		const { changesByPath, changeCount, latestSeq } = changelog;

		logger.info(`Incremental sync: ${changeCount} remote changes since seq ${context.settings.lastSeq}`);

		context.reportWork?.({ phase: 'scanning' });
		const unchangedPaths: string[] = [];
		const { changes: localChanges, discoveredPaths, skippedPaths } = await context.getLocalChanges(path => unchangedPaths.push(path));
		if (skippedPaths?.length) (result.issues ??= []).push(...skippedPaths.map(skippedFileIssue));
		const localDeletes = await context.getLocalDeletes(discoveredPaths);
		logger.info(`Incremental sync: ${localChanges.length} local changes detected`);
		logger.info(`Incremental sync: ${localDeletes.length} local deletes detected`);

		result.settledPaths.push(...unchangedPaths.filter(path => !changesByPath.has(path)).map(path => pendingChangeKey('upload', path)));

		if (changeCount === 0 && localChanges.length === 0 && localDeletes.length === 0) {
			if (unchangedPaths.length > 0) await context.localManifest.save();
			context.setLastSeq(latestSeq);
			return result;
		}


		const {
			discoveredLocalChanges,
			resurrectPaths,
			restoreDeletedPaths,
			remoteUnchangedLocalDeletes,
			reclassifiedPaths,
			downloadRequests,
			conflicts,
		} = await reconcileIncrementalRemoteChanges(context, changesByPath, localChanges, localDeletes, result);

		const localOnlyChanges = [...localChanges, ...discoveredLocalChanges].filter(
			(file) =>
				(!changesByPath.has(file.path) || resurrectPaths.has(file.path) || reclassifiedPaths.has(file.path))
				&& !context.shouldIgnore(file.path),
		);
		const localOnlyDeletes = localDeletes.filter(
			(path) => (!changesByPath.has(path) || remoteUnchangedLocalDeletes.has(path))
				&& !context.shouldIgnore(path),
		);
		const total = changesByPath.size + localOnlyChanges.length + localOnlyDeletes.length;
		let current = 0;
		options.progressCallback?.(current, total);

		if (downloadRequests.length > 0) {
			let downloadsProcessed = 0;
			context.reportWork?.({ phase: 'downloading', current: downloadsProcessed, total: downloadRequests.length });
			await context.parallelDownloadAndSaveFiles(downloadRequests, result, () => {
				downloadsProcessed++;
				current++;
				context.reportWork?.({ phase: 'downloading', current: downloadsProcessed, total: downloadRequests.length });
				options.progressCallback?.(current, total);
			}, options.onFailure);
			const downloaded = new Set(result.downloadedPaths);
			for (const path of restoreDeletedPaths) {
				if (downloaded.has(path) && !hasUnresolvedConflict(result, path)) {
					recordResolvedRace(result, path, "kept-remote-edit");
				}
			}
		}

		await applyDiffs(context, conflicts, result, {
			localFiles: () => createPathRecord<FileEntry>(),
			beforeDiff: () => context.reportWork?.({ phase: 'applying' }),
			onFailure: options.onFailure,
		});

		current = changesByPath.size;
		options.progressCallback?.(current, total);

		if (localOnlyChanges.length) context.reportWork?.({ phase: 'preparing' });
		let uploadsProcessed = 0;
		const reportUploads = (count: number) => {
			uploadsProcessed += count;
			context.reportWork?.({ phase: 'uploading', current: uploadsProcessed, total: localOnlyChanges.length });
			current += count;
			options.progressCallback?.(current, total);
		};
		await uploadPipelined(context, localOnlyChanges, result, {
			prepare: async (file) => {
				context.throwIfDestroyed();
				try {
					const uploadFile = await context.prepareUploadFromPath(file.path);
					if (uploadFile) {
						if (resurrectPaths.has(file.path)) {
							uploadFile.expectedHash = null;
						}
						return uploadFile;
					}
				} catch (error) {
					if (isAbortError(error)) throw error;
					recordSyncError(result, `${errorMessage(error)}`, file.path);
					options.onFailure?.(fileFailure(file.path, error));
				}
				current++;
				options.progressCallback?.(current, total);
				return null;
			},
			retry: true,
			onFailure: options.onFailure,
			...(context.reconcileVersionConflicts ? {
				onVersionConflicts: (paths: string[], syncResult: SyncResult) =>
					context.reconcileVersionConflicts!(paths, syncResult),
			} : {}),
			beforeChunk: () => {
				context.throwIfDestroyed();
				context.reportWork?.({ phase: 'uploading', current: uploadsProcessed, total: localOnlyChanges.length });
			},
			onProcessed: reportUploads,
			afterChunk: reportUploads,
		});
		const uploaded = new Set(result.uploadedPaths);
		for (const path of resurrectPaths) {
			if (uploaded.has(path)) {
				recordResolvedRace(result, path, "kept-local-edit");
			}
		}

		if (localOnlyDeletes.length > 0) {
			const deleteFailures = await applyIncrementalLocalDeletes(context, localOnlyDeletes, result, count => {
				current += count;
				options.progressCallback?.(current, total);
			});
			for (const failure of deleteFailures) options.onFailure?.(failure);
		}

		context.reportWork?.({ phase: 'saving' });
		await context.localManifest.save();
		if (finalizeSyncResult(result)) {
			context.setLastSeq(latestSeq);
		}

		logger.info(
			`Incremental sync completed: ${result.uploaded} up, ${result.downloaded} down, ${result.merged} merged, ${result.deleted} del, ${result.conflicts.length} conflicts`,
		);
		return result;
	} catch (error) {
		if (isAbortError(error)) {
			return cancelSyncResult(result);
		}

		// A dropped connection or busy server is retried incrementally; falling back
		// would re-read and hash the whole vault for a transient failure.
		if (isTransientSyncFailure(error)) {
			logger.warn("Incremental sync failed with a transient error:", errorMessage(error));
			recordSyncError(result, error);
			finalizeSyncResult(result);
			return result;
		}
		logger.warn("Incremental sync failed, falling back to full sync:", errorMessage(error));
		return null;
	}
}

/** Plan from the acknowledged baseline; all transfer policy lives in the shared executor. */
async function applyIncrementalLocalDeletes(
	context: Pick<IncrementalSyncPlannerContext, 'files' | 'vault' | 'localManifest' | 'reconcileVersionConflicts' | 'reportWork'>,
	paths: readonly string[],
	result: SyncResult,
	onProcessed?: (count: number) => void,
): Promise<MutationFailure[]> {
	const files = createDeleteCandidates(paths.map(path => {
		const entry = context.localManifest.getEntry(path);
		return { path, hash: entry?.hash, revision: entry?.revision };
	}), result);
	return deleteRemoteFiles(context, files, result, {
		onProcessed,
		onVersionConflicts: context.reconcileVersionConflicts,
	});
}
