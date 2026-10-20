import { pendingChangeKey } from '../pending/pending-change';
import { isAbortError } from '../abort';
import { readLocalFileEntry } from '../local/local-file-entry';
import { deletePathLocallyIfUnchanged } from '../local/local-delete';
import { classifyPath } from './reconciliation';
import type { IncrementalSyncPlannerContext } from './types';
import type { DownloadRequest } from '../transfer/download';
import { recordSyncError } from '../issues';
import type { ChangelogEntry, FileEntry } from '../../protocol/sync-types';
import type { FileDiff, SyncResult } from '../types';
import { MAX_FILE_SIZE_BYTES } from '../../protocol/sync-limits';
import { isVaultTFileLike } from '../local/local-delete';
import { assertLocalSyncPath } from '../local/local-path-safety';

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

	for (const [path, entry] of changesByPath) {
		if (context.shouldIgnore(path)) continue;

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
						resurrectPaths.add(path);
						continue;
					}
				}

				const expectedLocalHash = context.localManifest.getEntry(path)?.hash ?? null;
				const localDelete = await deletePathLocallyIfUnchanged(context, path, expectedLocalHash);
				if (localDelete.status === 'changed') {
					resurrectPaths.add(path);
					localChangedPaths.add(path);
					const localChange = { path, hash: localDelete.hash };
					discoveredLocalChanges.push(localChange);
					localChangeByPath.set(path, localChange);
					continue;
				}
				context.localManifest.removeEntry(path);
				if (localDelete.status === 'deleted') {
					result.deleted++;
					result.deletedPaths.push(path);
				}
				continue;
			}

			if (entry.size > MAX_FILE_SIZE_BYTES) {
				recordSyncError(result, 'Skipped remote file larger than 25MB', path);
				continue;
			}

			if (localDeletedPaths.has(path)) {
				const decision = classifyPath(
					path,
					undefined,
					{ hash: entry.hash, size: entry.size, modified: entry.created_at, revision: entry.revision },
					context.localManifest.getEntry(path),
				);
				if (decision?.action === 'delete') {
					remoteUnchangedLocalDeletes.add(path);
					continue;
				}
				if (decision?.action === 'download' && decision.cause === 'local-deleted') {
					restoreDeletedPaths.add(path);
				}
				downloadRequests.push({
					path,
					expectedLocalHash: null,
					expectedRemoteHash: entry.hash,
					remoteSize: entry.size,
				});
				continue;
			}

			const localEntry = localChangedPaths.has(path)
				? await readLocalFileEntry(context.vault, path)
				: await readUnchangedLocalEntry(context, path);
			if (!localEntry) {
				downloadRequests.push({
					path,
					expectedLocalHash: null,
					expectedRemoteHash: entry.hash,
					remoteSize: entry.size,
				});
				continue;
			}

			const decision = classifyPath(
				path,
				localEntry,
				{ hash: entry.hash, size: entry.size, modified: entry.created_at, revision: entry.revision },
				context.localManifest.getEntry(path),
			);

			if (!decision) {
				context.localManifest.setEntry(path, { ...localEntry, revision: entry.revision });
				result.settledPaths.push(pendingChangeKey('upload', path));
			} else if (decision.action === 'upload') {
				if (!localChangedPaths.has(path)) {
					localChangedPaths.add(path);
					const localChange = { path, hash: localEntry.hash };
					discoveredLocalChanges.push(localChange);
					localChangeByPath.set(path, localChange);
				}
				if (decision.cause === 'local-edited') reclassifiedPaths.add(path);
			} else if (decision.action === 'conflict') {
				conflicts.push(decision);
			} else if (decision.action === 'download') {
				downloadRequests.push({
					path,
					expectedLocalHash: localEntry.hash,
					expectedRemoteHash: entry.hash,
					remoteSize: entry.size,
				});
			}
		} catch (error) {
			if (isAbortError(error)) throw error;
			recordSyncError(result, error, path);
		}
	}

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
	return readLocalFileEntry(context.vault, path);
}
