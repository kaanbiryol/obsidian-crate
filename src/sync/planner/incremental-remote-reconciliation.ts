import { pendingChangeKey } from '../pending/pending-change';
import { isAbortError } from '../abort';
import { readLocalFileEntry } from '../local/local-file-entry';
import { deletePathLocallyIfUnchanged } from '../local/local-delete';
import { classifyPath } from './reconciliation';
import type { IncrementalSyncPlannerContext } from './types';
import type { DownloadRequest } from '../transfer/download';
import { oversizedRemoteFileIssue, recordSyncError } from '../issues';
import type { ChangelogEntry, FileEntry } from '../../protocol/sync-types';
import type { SyncResult } from '../types';
import type { FileDiff } from './types';
import { isVaultTFileLike } from '../local/local-delete';
import { assertLocalSyncPath, unsupportedLocalPathIssue } from '../local/local-path-safety';
import { portablePathKey } from '../../protocol/portable-path';
import { runConcurrentTasks } from '../concurrency';
import { REMOTE_RECONCILE_CONCURRENCY } from '../transfer/constants';

export interface IncrementalRemoteReconciliation {
	discoveredLocalChanges: Array<{ path: string; hash: string }>;
	resurrectPaths: Set<string>;
	restoreDeletedPaths: Set<string>;
	remoteUnchangedLocalDeletes: Set<string>;
	reclassifiedPaths: Set<string>;
	downloadRequests: DownloadRequest[];
	conflicts: FileDiff[];
}

/** Reconciles remote changes against current bytes, applying guarded local deletes
 * and updating the acknowledged manifest. Newly found local edits are returned
 * separately so the caller owns its local-change inventory. */
export async function reconcileIncrementalRemoteChanges(
	context: IncrementalSyncPlannerContext,
	changesByPath: ReadonlyMap<string, ChangelogEntry>,
	localChanges: ReadonlyArray<{ path: string; hash: string }>,
	localDeletes: readonly string[],
	result: SyncResult,
): Promise<IncrementalRemoteReconciliation> {
	const discoveredLocalChanges: Array<{ path: string; hash: string }> = [];
	const localChangedPaths = new Set(localChanges.map((file) => file.path));
	const localChangeByPath = new Map(localChanges.map((file) => [file.path, file] as const));
	const localDeletedPaths = new Set(localDeletes);
	const resurrectPaths = new Set<string>();
	const restoreDeletedPaths = new Set<string>();
	const remoteUnchangedLocalDeletes = new Set<string>();
	const reclassifiedPaths = new Set<string>();
	const downloadRequests: DownloadRequest[] = [];
	const conflicts: FileDiff[] = [];
	const moved = await applyRemoteMoves(context, changesByPath, localChangedPaths, localDeletedPaths, result);

	// Each path reads, hashes or trashes only its own file, so several run at once. Paths one
	// case-insensitive name can hold run in order, and outcomes are recorded in changelog
	// order, so the result matches reconciling one path at a time. Manifest updates are
	// made as each path settles, like before, so a cancelled run keeps them.
	const outcomes = new Map<string, Array<() => void>>();
	const reconcile = async (path: string, entry: ChangelogEntry): Promise<void> => {
		const effects: Array<() => void> = [];
		outcomes.set(path, effects);
		const later = (effect: () => void) => { effects.push(effect); };
		const unsupported = unsupportedLocalPathIssue(path);
		if (unsupported) { later(() => (result.issues ??= []).push(unsupported)); return; }

		try {
			if (entry.action === 'delete') {
				if (localChangedPaths.has(path)) {
					const localChange = localChangeByPath.get(path);
					const decision = localChange
						? classifyPath(
							path,
							{ hash: localChange.hash, size: 0, modified: entry.created_at },
							undefined,
							context.localManifest.getEntry(path),
						)
						: null;
					if (decision?.action === 'upload') {
						later(() => resurrectPaths.add(path));
						return;
					}
				}

				const baseline = context.localManifest.getEntry(path);
				// This device never synced the path, so there is nothing to delete here. A
				// local file created at it is a local change for the scan to upload.
				if (!baseline) return;
				const localDelete = await deletePathLocallyIfUnchanged(context, path, baseline.hash);
				if (localDelete.status === 'changed') {
					const localChange = { path, hash: localDelete.hash };
					later(() => {
						resurrectPaths.add(path);
						localChangedPaths.add(path);
						discoveredLocalChanges.push(localChange);
						localChangeByPath.set(path, localChange);
					});
					return;
				}
				context.localManifest.removeEntry(path);
				if (localDelete.status === 'deleted') later(() => { result.deleted++; result.deletedPaths.push(path); });
				return;
			}

			// This device cannot store it, like an oversized local file: report it without
			// failing the sync, so the changelog cursor still advances past it.
			if (entry.size > context.maxFileBytes()) {
				const issue = oversizedRemoteFileIssue(path, context.maxFileBytes());
				later(() => (result.issues ??= []).push(issue));
				return;
			}

			if (localDeletedPaths.has(path)) {
				const decision = classifyPath(
					path,
					undefined,
					{ hash: entry.hash, size: entry.size, modified: entry.created_at, revision: entry.revision },
					context.localManifest.getEntry(path),
				);
				if (decision?.action === 'delete') {
					later(() => remoteUnchangedLocalDeletes.add(path));
					return;
				}
				later(() => {
					if (decision?.action === 'download' && decision.cause === 'local-deleted') restoreDeletedPaths.add(path);
					downloadRequests.push({ path, expectedLocalHash: null, expectedRemoteHash: entry.hash, remoteSize: entry.size });
				});
				return;
			}

			const localEntry = localChangedPaths.has(path)
				? await readLocalFileEntry(context.vault, path, context.maxFileBytes())
				: await readUnchangedLocalEntry(context, path);
			if (!localEntry) {
				later(() => downloadRequests.push({ path, expectedLocalHash: null, expectedRemoteHash: entry.hash, remoteSize: entry.size }));
				return;
			}

			const decision = classifyPath(
				path,
				localEntry,
				{ hash: entry.hash, size: entry.size, modified: entry.created_at, revision: entry.revision },
				context.localManifest.getEntry(path),
			);

			if (!decision) {
				context.localManifest.setEntry(path, { ...localEntry, revision: entry.revision });
				later(() => result.settledKeys.push(pendingChangeKey('upload', path)));
			} else if (decision.action === 'upload') {
				later(() => {
					if (!localChangedPaths.has(path)) {
						localChangedPaths.add(path);
						const localChange = { path, hash: localEntry.hash };
						discoveredLocalChanges.push(localChange);
						localChangeByPath.set(path, localChange);
					}
					if (decision.cause === 'local-edited') reclassifiedPaths.add(path);
				});
			} else if (decision.action === 'conflict') {
				later(() => conflicts.push(decision));
			} else if (decision.action === 'download') {
				later(() => downloadRequests.push({ path, expectedLocalHash: localEntry.hash, expectedRemoteHash: entry.hash, remoteSize: entry.size }));
			}
		} catch (error) {
			if (isAbortError(error)) throw error;
			later(() => recordSyncError(result, error, path));
		}
	};
	const groups = new Map<string, Array<[string, ChangelogEntry]>>();
	for (const [path, entry] of changesByPath) {
		if (context.shouldIgnore(path) || moved.has(path)) continue;
		const key = portablePathKey(path);
		const group = groups.get(key);
		if (group) group.push([path, entry]); else groups.set(key, [[path, entry]]);
	}
	await runConcurrentTasks([...groups.values()].map(group => async () => {
		for (const [path, entry] of group) await reconcile(path, entry);
	}), REMOTE_RECONCILE_CONCURRENCY, context.signal);
	for (const path of changesByPath.keys()) for (const effect of outcomes.get(path) ?? []) effect();

	return {
		discoveredLocalChanges,
		resurrectPaths,
		restoreDeletedPaths,
		remoteUnchangedLocalDeletes,
		reclassifiedPaths,
		downloadRequests,
		conflicts,
	};
}

/** A remote rename arrives as a delete of the old path and a write of the same bytes at the
 * new one. Moving the unchanged local file there saves downloading it again; a pair the move
 * cannot apply, or any other change, is reconciled as usual. Returns both paths of each move. */
async function applyRemoteMoves(
	context: IncrementalSyncPlannerContext,
	changesByPath: ReadonlyMap<string, ChangelogEntry>,
	localChangedPaths: ReadonlySet<string>,
	localDeletedPaths: ReadonlySet<string>,
	result: SyncResult,
): Promise<Set<string>> {
	const moved = new Set<string>();
	if (!context.moveUnchangedLocalFile) return moved;
	const eligible = (path: string) => !context.shouldIgnore(path) && !unsupportedLocalPathIssue(path)
		&& !localChangedPaths.has(path) && !localDeletedPaths.has(path);
	// Old paths by the hash of their synced bytes.
	const sources = new Map<string, string[]>();
	for (const [path, entry] of changesByPath) {
		const baseline = entry.action === 'delete' && eligible(path) ? context.localManifest.getEntry(path) : undefined;
		if (!baseline) continue;
		const paths = sources.get(baseline.hash);
		if (paths) paths.push(path); else sources.set(baseline.hash, [path]);
	}
	if (!sources.size) return moved;
	for (const [path, entry] of changesByPath) {
		if (entry.action === 'delete' || !eligible(path) || context.localManifest.getEntry(path) || entry.size > context.maxFileBytes()) continue;
		const candidates = sources.get(entry.hash);
		// A case or Unicode-only rename keeps its own handling.
		const from = candidates?.find(source => portablePathKey(source) !== portablePathKey(path));
		if (!from) continue;
		candidates!.splice(candidates!.indexOf(from), 1);
		try {
			if (!await context.moveUnchangedLocalFile(from, path, entry.hash, entry.revision)) continue;
		} catch (error) {
			if (isAbortError(error)) throw error;
			// Reconciled as a delete and a download, which check the files as they are now.
			continue;
		}
		context.localManifest.removeEntry(from);
		moved.add(from).add(path);
		result.deleted++;
		result.deletedPaths.push(from);
		result.downloaded++;
		result.downloadedPaths.push(path);
	}
	return moved;
}

/** The local scan trusts matching metadata, so a file it found unchanged reuses
 * its baseline hash while a fresh stat still matches. Edits since the scan
 * change that metadata and are read again. */
async function readUnchangedLocalEntry(context: IncrementalSyncPlannerContext, path: string): Promise<FileEntry | undefined> {
	assertLocalSyncPath(path);
	const baseline = context.localManifest.getEntry(path);
	if (baseline) {
		const file = context.vault.getAbstractFileByPath(path);
		const stat = isVaultTFileLike(file) ? file.stat : await context.vault.adapter.stat(path);
		if (stat && (!('type' in stat) || stat.type === 'file') && stat.size === baseline.size
			&& Date.parse(baseline.modified) === stat.mtime) {
			return { hash: baseline.hash, size: baseline.size, modified: baseline.modified };
		}
	}
	return readLocalFileEntry(context.vault, path, context.maxFileBytes());
}
