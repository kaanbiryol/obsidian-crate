import { decodePendingChange, pendingChangeKey } from '../pending/pending-change';
import { isAbortError } from '../abort';
import { recordSyncError } from '../issues';
import type { Vault } from 'obsidian';
import { readLocalFileEntry } from '../local/local-file-entry';
import { classifyPath } from '../planner/reconciliation';
import { isQueueVersionConflict } from '../queue/failure';
import { cancelSyncResult, createEmptySyncResult, finalizeSyncResult } from '../sync-result';
import { RemoteVersionChangedError } from '../transfer/download';
import type { FileDiff, SyncResult, SyncWork, UploadDiff } from '../types';
import type { FileEntry } from '../../protocol/sync-types';
import { errorMessage } from '../logger';
import type { DiffApplyOutcome } from '../transfer/types';
import { createPathRecord, getPathEntry } from '../../protocol/path-record';
import type { DeleteRemoteFiles } from '../transfer/delete';
import type { ConditionalDeleteCandidate } from '../transfer/delete-batches';
import { HttpError } from '../worker-api/http';

const MAX_RECONCILE_ATTEMPTS = 3;

interface TargetedManifest {
	getEntry(path: string): Readonly<FileEntry> | undefined;
	setEntry(path: string, entry: FileEntry): void;
	removeEntry(path: string): void;
	save(): Promise<void>;
}

export interface TargetedReconcileContext {
	deleteRemoteFiles: DeleteRemoteFiles;
	reportWork?(work: SyncWork): void;
	vault: Vault;
	localManifest: TargetedManifest;
	getRemoteEntries(paths: string[]): Promise<Record<string, FileEntry>>;
	shouldIgnore(path: string): boolean;
	/** Upload ordinary edits together; return paths that need fresh reconciliation. */
	uploadDiffs?(diffs: UploadDiff[], result: SyncResult): Promise<string[]>;
	processDiff(
		diff: FileDiff,
		localFiles: Record<string, FileEntry>,
		result: SyncResult,
	): Promise<DiffApplyOutcome>;
}

/** Reconcile selected files or queue paths that lost a compare-and-swap race. */
export async function reconcileQueuePaths(
	context: TargetedReconcileContext,
	queueKeys: string[],
): Promise<SyncResult> {
	const result = createEmptySyncResult();
	try {
		const uniqueQueueKeys = [...new Set(queueKeys)];
		const targetPaths = [...new Set(uniqueQueueKeys.map(queueKey =>
			decodePendingChange(queueKey).path))];
		context.reportWork?.({ phase: 'server' });
		const remoteEntries = createPathRecord(await context.getRemoteEntries(targetPaths));
		let processed = 0;
		const reportProgress = () => context.reportWork?.({ phase: 'applying', current: processed, total: uniqueQueueKeys.length });
		reportProgress();

		// Settle uploads and acknowledge matching server copies before deleting old
		// rename sources. Queue insertion order puts the old name first.
		const deletions: string[] = [];
		const deleteCandidates = new Map<string, { file: ConditionalDeleteCandidate; keys: string[] }>();
		const uploads = new Map<string, { diff: UploadDiff; keys: string[] }>();
		async function reconcile(queueKey: string, allowDelete: boolean, firstAttempt = 1, collectUploads = false, collectDeletes = false) {
			const path = decodePendingChange(queueKey).path;
			if (context.shouldIgnore(path)) {
				result.settledPaths.push(queueKey);
				processed++;
				reportProgress();
				return;
			}

			let settled = false;
			let deletionDeferred = false;
			for (let attempt = firstAttempt; attempt <= MAX_RECONCILE_ATTEMPTS; attempt++) {
				try {
					const localEntry = await readLocalFileEntry(context.vault, path);
					const remoteEntry = getPathEntry(remoteEntries, path);
					const baseEntry = context.localManifest.getEntry(path);
					const decision = classifyPath(path, localEntry, remoteEntry, baseEntry);
					if (decision?.action === 'upload' && collectUploads && context.uploadDiffs) {
						const upload = uploads.get(path) ?? { diff: decision, keys: [] };
						upload.keys.push(queueKey);
						uploads.set(path, upload);
						return;
					}
					if (decision?.action === 'delete' && !allowDelete) {
						deletions.push(queueKey);
						deletionDeferred = true;
						break;
					}
					if (decision?.action === 'delete' && collectDeletes) {
						if (!decision.remoteHash) throw new Error('Missing remote version for delete');
						const candidate = deleteCandidates.get(path) ?? { file: { path, expectedHash: decision.remoteHash, expectedRevision: decision.remoteRevision }, keys: [] };
						candidate.keys.push(queueKey);
						deleteCandidates.set(path, candidate);
						return;
					}
					const localFiles = createPathRecord<FileEntry>();
					if (localEntry) localFiles[path] = localEntry;

					if (decision) {
						if (decision.action === 'delete' && result.errors.length > 0) {
							throw new Error('Remote deletion deferred until uploads and reconciliation finish successfully');
						}
						let outcome: DiffApplyOutcome;
						if (decision.action === 'delete') {
							const failures = await context.deleteRemoteFiles([{ path, expectedHash: decision.remoteHash, expectedRevision: decision.remoteRevision }], result, { onVersionConflicts: async () => {} });
							if (failures.length) {
								const failure = failures[0]!;
								if (isQueueVersionConflict(failure.status, failure.code)) {
									throw new HttpError(failure.error, failure.status ?? 409, null, failure.code);
								}
								break;
							}
							outcome = { status: 'applied' };
						} else outcome = await context.processDiff(decision, localFiles, result);
						if (outcome.status === 'deferred') {
							if (attempt < MAX_RECONCILE_ATTEMPTS) {
								await refreshRemoteEntry(context, remoteEntries, path);
								continue;
							}
							throw new Error(outcome.reason);
						}
					} else if (localEntry && remoteEntry) {
						context.localManifest.setEntry(path, {
							...remoteEntry,
							modified: localEntry.modified,
						});
					} else {
						context.localManifest.removeEntry(path);
					}

					result.settledPaths.push(queueKey);
					settled = true;
					break;
				} catch (error) {
					if (isAbortError(error)) throw error;
					const remoteVersionChanged = error instanceof RemoteVersionChangedError
						|| (error instanceof HttpError && isQueueVersionConflict(error.status, error.code));
					if (remoteVersionChanged && attempt < MAX_RECONCILE_ATTEMPTS) {
						await refreshRemoteEntry(context, remoteEntries, path);
						continue;
					}
					recordSyncError(result, `${errorMessage(error)}`, path);
					break;
				}
			}

			if (!settled && !deletionDeferred && !result.errors.some((error) => error.startsWith(`${path}:`))) {
				recordSyncError(result, `Reconciliation did not converge`, path);
			}
			// Retries and deferred deletions belong to the same queued change.
			if (!deletionDeferred) {
				processed++;
				reportProgress();
			}
		}
		for (const queueKey of uniqueQueueKeys) await reconcile(queueKey, false, 1, true);
		if (uploads.size && context.uploadDiffs) {
			const retryPaths = new Set(await context.uploadDiffs([...uploads.values()].map(upload => upload.diff), result));
			const uploadedPaths = new Set(result.uploadedPaths);
			for (const [path, upload] of uploads) {
				if (retryPaths.has(path)) {
					try {
						await refreshRemoteEntry(context, remoteEntries, path);
					} catch (error) {
						if (isAbortError(error)) throw error;
						recordSyncError(result, errorMessage(error), path);
						processed += upload.keys.length;
						reportProgress();
						continue;
					}
					for (const key of upload.keys) await reconcile(key, false, 2);
				} else {
					if (uploadedPaths.has(path)) result.settledPaths.push(...upload.keys);
					processed += upload.keys.length;
					reportProgress();
				}
			}
		}
		for (const queueKey of deletions) await reconcile(queueKey, true, 1, false, true);
		if (deleteCandidates.size) {
			const retryKeys = new Set<string>();
			await context.deleteRemoteFiles([...deleteCandidates.values()].map(candidate => candidate.file), result, {
				onProcessed: count => { processed += count; },
				onVersionConflicts: async keys => { for (const key of keys) retryKeys.add(key); },
			});
			const deleted = new Set(result.deletedPaths);
			for (const [path, candidate] of deleteCandidates) {
				if (retryKeys.has(pendingChangeKey('delete', path))) {
					processed -= 1;
					try {
						await refreshRemoteEntry(context, remoteEntries, path);
					} catch (error) {
						if (isAbortError(error)) throw error;
						recordSyncError(result, errorMessage(error), path);
						processed++;
						continue;
					}
					for (const key of candidate.keys) await reconcile(key, true, 2);
				} else if (deleted.has(path)) result.settledPaths.push(...candidate.keys);
			}
		}

		context.reportWork?.({ phase: 'saving' });
		await context.localManifest.save();
		finalizeSyncResult(result);
		return result;
	} catch (error) {
		if (isAbortError(error)) return cancelSyncResult(result);
		throw error;
	}
}

async function refreshRemoteEntry(
	context: Pick<TargetedReconcileContext, 'getRemoteEntries'>,
	remoteEntries: Record<string, FileEntry>,
	path: string,
): Promise<void> {
	const refreshed = await context.getRemoteEntries([path]);
	const entry = getPathEntry(refreshed, path);
	if (entry) remoteEntries[path] = entry;
	else delete remoteEntries[path];
}
