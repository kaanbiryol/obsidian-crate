import { computeHash } from './hasher';
import { isHiddenPath } from './file-discovery';
import { deletePathLocallyIfUnchanged, isVaultTFileLike } from './planner-helpers';
import { classifyPath } from './reconciliation';
import type { IncrementalSyncPlannerContext } from './planner-types';
import type { DownloadRequest } from './transfer-download';
import { errorMessage } from '../plugin/logger';
import type { ChangelogEntry, FileDiff, SyncResult } from '../plugin/types';
import { MAX_FILE_SIZE_BYTES } from '../plugin/types';

export interface IncrementalRemotePlan {
	resurrectPaths: Set<string>;
	restoreDeletedPaths: Set<string>;
	remoteUnchangedLocalDeletes: Set<string>;
	reclassifiedPaths: Set<string>;
	downloadRequests: DownloadRequest[];
	conflicts: FileDiff[];
}

export async function planIncrementalRemoteChanges(
	context: IncrementalSyncPlannerContext,
	changesByPath: ReadonlyMap<string, ChangelogEntry>,
	localChanges: Array<{ path: string; hash: string }>,
	localDeletes: string[],
	result: SyncResult,
): Promise<IncrementalRemotePlan> {
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
					localChanges.push(localChange);
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
				result.errors.push(`${path}: Skipped remote file larger than 25MB`);
				continue;
			}

			if (localDeletedPaths.has(path)) {
				const decision = classifyPath(
					path,
					undefined,
					{ hash: entry.hash, size: entry.size, modified: entry.created_at },
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

			const localFile = context.vault.getAbstractFileByPath(path);
			if (!localFile && !(isHiddenPath(path) && await context.vault.adapter.exists(path))) {
				downloadRequests.push({
					path,
					expectedLocalHash: null,
					expectedRemoteHash: entry.hash,
					remoteSize: entry.size,
				});
				continue;
			}

			const stat = isVaultTFileLike(localFile)
				? localFile.stat
				: await context.vault.adapter.stat(path);
			if ((stat?.size ?? 0) > MAX_FILE_SIZE_BYTES) {
				result.errors.push(`${path}: Skipped local file larger than 25MB`);
				continue;
			}

			const content = await context.vault.adapter.readBinary(path);
			const localHash = await computeHash(content);
			const localModified = new Date(stat?.mtime ?? Date.now()).toISOString();
			const decision = classifyPath(
				path,
				{ hash: localHash, size: stat?.size ?? content.byteLength, modified: localModified },
				{ hash: entry.hash, size: entry.size, modified: entry.created_at },
				context.localManifest.getEntry(path),
			);

			if (!decision) {
				context.localManifest.setEntry(path, {
					hash: localHash,
					size: stat?.size ?? 0,
					modified: localModified,
				});
			} else if (decision.action === 'upload') {
				if (!localChangedPaths.has(path)) {
					localChangedPaths.add(path);
					const localChange = { path, hash: localHash };
					localChanges.push(localChange);
					localChangeByPath.set(path, localChange);
				}
				if (decision.cause === 'local-edited') reclassifiedPaths.add(path);
			} else if (decision.action === 'conflict') {
				conflicts.push(decision);
			} else if (decision.action === 'download') {
				downloadRequests.push({
					path,
					expectedLocalHash: localHash,
					expectedRemoteHash: entry.hash,
					remoteSize: entry.size,
				});
			}
		} catch (error) {
			result.errors.push(`${path}: ${errorMessage(error)}`);
		}
	}

	return {
		resurrectPaths,
		restoreDeletedPaths,
		remoteUnchangedLocalDeletes,
		reclassifiedPaths,
		downloadRequests,
		conflicts,
	};
}
