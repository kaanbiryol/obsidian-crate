import { decodePendingChange } from '../pending/pending-change';
import { createAbortError } from '../abort';
import type { SyncEngine } from '../engine/engine';
import type { SyncHistoryEntry, SyncResult } from '../types';
import { mergeSyncResults } from '../sync-result';
import type { SyncSettings } from '../settings';

type HistoryEngine = Pick<SyncEngine, 'createHistoryRestore' | 'updateSettings' | 'getPendingKeys' | 'syncSelected' | 'sync'>;
interface HistoryRestoreContext {
	engine: HistoryEngine;
	settings: SyncSettings;
	verify: () => void;
	clearForegroundSyncTimer: () => void;
	persistSettings: (update?: Partial<SyncSettings>) => Promise<void>;
	runSyncOperation: (operation: (engine: HistoryEngine, progress: (current: number, total: number) => void) => Promise<SyncResult>) => Promise<SyncResult>;
}

export async function loadRuntimeHistoryComparison(engine: Pick<SyncEngine, 'loadHistoryComparison'>, verify: () => void,
		entry: SyncHistoryEntry) {
		const id = entry.sharedCheckpoint;
		if (!id) throw new Error('This sync has no saved state to preview.');
		verify();
		const comparison = await engine.loadHistoryComparison(id);
		verify();
		return { ...comparison, preview: async (path: string) => {
				verify();
				const preview = await comparison.preview(path);
				verify();
				return preview;
		} };
}

/** Preserve pause/persist/apply/sync/verify/resume ordering as one workflow. */
export async function createRuntimeHistoryRestore({ engine, settings, verify, clearForegroundSyncTimer, persistSettings, runSyncOperation }: HistoryRestoreContext,
		entry: SyncHistoryEntry) {
		const id = entry.sharedCheckpoint;
		if (!id) throw new Error('This history entry has no complete vault checkpoint.');
		let automaticSync = false;
		const review = await engine.createHistoryRestore(id, async () => {
				verify();
				automaticSync = settings.automaticSync;
				// Persist the pause before changing files, including across a crash.
				settings.automaticSync = false;
				clearForegroundSyncTimer();
				engine.updateSettings(settings);
				await persistSettings({ automaticSync: false });
				verify();
		});
		verify();
		return { items: review.items, unchangedCount: review.unchangedCount, preview: async (path: string) => {
				verify();
				const preview = await review.preview(path);
				verify();
				return preview;
		}, restore: async () => {
				verify();
				const unavailable = await review.restore();
				verify();
				if (!review.items.length) return unavailable;
				const result = await runSyncOperation(async (current, progress) => {
						const removed = new Set(review.items.filter(item => item.action === 'remove').map(item => item.path));
						const keys = removed.size ? current.getPendingKeys().filter(key => removed.has(decodePendingChange(key).path)) : [];
						// The verified local recovery copies allow explicit removals to
						// settle first, freeing paths for historical file/folder renames.
						const deletions = keys.length ? await current.syncSelected(keys) : undefined;
						if (deletions && (!deletions.success || deletions.conflicts.length)) return deletions;
						const synced = await current.sync(progress);
						if (deletions) mergeSyncResults(synced, deletions);
						return synced;
				});
				verify();
				if (result.outcome === 'cancelled') throw createAbortError('History restore sync cancelled');
				if (!result.success || result.conflicts.length) throw new Error('Restore needs attention during sync. Automatic sync is off; review Pending and Conflicts before continuing.');
				await review.verifySynced();
				verify();
				try {
						await persistSettings({ automaticSync });
				} catch (error) {
						settings.automaticSync = false;
						engine.updateSettings(settings);
						throw error;
				}
				verify();
				settings.automaticSync = automaticSync;
				engine.updateSettings(settings);
				return unavailable;
		} };
}
