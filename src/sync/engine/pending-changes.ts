import { pendingChangeKey, decodePendingChange } from '../pending/pending-change';
import type { Vault } from 'obsidian';
import { MAX_FILE_SIZE_BYTES, MAX_PREVIEW_BYTES } from '../../protocol/sync-limits';
import type { SyncApiClient } from '../worker-api/client';
import type { LocalManifest } from '../manifest/manifest';
import type { MarkdownBaseCache } from '../merge/markdown-base-cache';
import type { SyncQueueController } from '../queue/controller';
import type { SyncResult } from '../types';
import { assertLocalSyncPath } from '../local/local-path-safety';
import { readLocalFileEntry } from '../local/local-file-entry';
import { UNVERIFIED_MODIFIED } from '../transfer/applied-content';
import { loadRemotePendingBase } from '../pending/pending-baseline';
import { loadPendingDiff } from '../pending/pending-diff';
import { createPendingDiscard } from '../pending/pending-discard';
import { createEmptySyncResult } from '../sync-result';

interface EnginePendingChangesContext {
	vault: Vault;
	api: Pick<SyncApiClient, 'getFileMetadata' | 'downloadFile' | 'listFileVersions' | 'previewFileVersion'>;
	manifest: Pick<LocalManifest, 'getEntry' | 'setEntry' | 'removeEntry' | 'save'>;
	cache: Pick<MarkdownBaseCache, 'readBase'>;
	queue: Pick<SyncQueueController, 'getPendingKeys' | 'snapshotPendingRevisions' | 'clearSyncedPendingPaths'>;
	backupRoot: string;
	throwIfDestroyed(): void;
	isDestroyed(): boolean;
	beforeBinaryReplace(path: string): Promise<void>;
}

/** Pending review and baseline settlement; operation locks remain in the engine. */
export function createEnginePendingChanges(context: EnginePendingChangesContext) {
	return {
		async loadDiff(path: string, deleted: boolean) {
			assertLocalSyncPath(path);
			const baseline = context.manifest.getEntry(path);
			const verifyBaseline = () => {
				if (context.manifest.getEntry(path)?.hash !== baseline?.hash) {
					throw new Error('Pending changes were updated. Reopen the file to refresh its preview.');
				}
			};
			const preview = await loadPendingDiff(context.vault.adapter, baseline,
				async (filePath, hash) => {
					const cached = await context.cache.readBase(filePath, hash);
					verifyBaseline();
					return cached ?? (baseline ? await loadRemotePendingBase(context.api, filePath, baseline, MAX_PREVIEW_BYTES) : null);
				}, path, deleted);
			verifyBaseline();
			return preview;
		},

		async prepareDiscard(keys: string[]) {
			return createPendingDiscard({
				vault: context.vault,
				getBaseline: path => context.manifest.getEntry(path),
				readBase: async (path, baseline) => await context.cache.readBase(path, baseline.hash)
					?? loadRemotePendingBase(context.api, path, baseline, MAX_FILE_SIZE_BYTES),
				backupRoot: context.backupRoot,
				verify: () => context.throwIfDestroyed(),
				beforeBinaryReplace: path => context.beforeBinaryReplace(path),
				applied: async (path, remote, content) => {
					if (remote && content) {
						const local = await readLocalFileEntry(context.vault, path);
						context.manifest.setEntry(path, { ...remote, modified: local?.hash === remote.hash ? local.modified : 'unverified' });
					}
					else context.manifest.removeEntry(path);
					await context.manifest.save();
					const revisions = context.queue.snapshotPendingRevisions();
					const local = await readLocalFileEntry(context.vault, path);
					if ((local?.hash ?? null) === (remote?.hash ?? null)) {
						const result = createEmptySyncResult();
						result.settledPaths = [pendingChangeKey('upload', path), pendingChangeKey('delete', path)];
						context.queue.clearSyncedPendingPaths(result, revisions);
					}
				},
			}, keys);
		},

		async settleSynced(result: SyncResult, revisions: ReadonlyMap<string, number>): Promise<void> {
			if (context.isDestroyed()) return;
			context.queue.clearSyncedPendingPaths(result, revisions);
			if (!result.success) return;
			// Applying remote bytes emits vault events too. Verify those events against
			// the committed baseline instead of requiring another sync to clear them.
			const applied = new Set([
				...result.downloadedPaths,
				...result.mergedPaths,
				...result.deletedPaths,
				// Conflict copies stay local; remote content was applied to the originals.
				...result.unresolvedConflicts.map(conflict => conflict.path),
			]);
			const snapshot = context.queue.snapshotPendingRevisions();
			const settled = createEmptySyncResult();
			for (const key of context.queue.getPendingKeys()) {
				if (context.isDestroyed()) return;
				const path = decodePendingChange(key).path;
				if (!applied.has(path)) continue;
				const baseline = context.manifest.getEntry(path);
				try {
					if (baseline && baseline.modified !== UNVERIFIED_MODIFIED) {
						// Applying the bytes verified them together with this modification
						// time, so an unchanged stat settles the event without rereading.
						const stat = await context.vault.adapter.stat(path);
						if (context.isDestroyed()) return;
						if (context.manifest.getEntry(path) !== baseline) continue;
						if (stat?.type === 'file' && stat.size === baseline.size
							&& new Date(stat.mtime).toISOString() === baseline.modified) {
							settled.settledPaths.push(key);
							continue;
						}
					}
					const local = await readLocalFileEntry(context.vault, path);
					if (context.isDestroyed()) return;
					if (context.manifest.getEntry(path) !== baseline) continue;
					if (local?.hash === baseline?.hash) settled.settledPaths.push(key);
				} catch {
					// Unreadable files remain pending for the next sync.
				}
			}
			// Events arriving during verification must still remain pending.
			context.queue.clearSyncedPendingPaths(settled, snapshot);
		},
	};
}
