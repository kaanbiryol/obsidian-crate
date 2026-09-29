import { compareHistorySnapshots, type HistorySnapshot } from './history-comparison';
import type { SyncEngine } from './engine';
import type { CrateSettings } from '../plugin/settings-types';
import type { SyncHistoryEntry, SyncResult } from './types';
import { mergeSyncResults } from './sync-result';

type HistoryEngine = Pick<SyncEngine, 'createHistoryRestore' | 'updateSettings' | 'getPendingPaths' | 'syncSelected' | 'sync'>;
interface HistoryRestoreContext {
  engine: HistoryEngine;
  settings: CrateSettings;
  verify: () => void;
  clearForegroundSyncTimer: () => void;
  persistSettings: (update?: Partial<CrateSettings>) => Promise<void>;
  runSyncOperation: (operation: (engine: HistoryEngine, progress: (current: number, total: number) => void) => Promise<SyncResult>) => Promise<SyncResult>;
}

export async function loadRuntimeHistoryComparison(engine: Pick<SyncEngine, 'loadHistorySnapshot'>, verify: () => void,
    entry: SyncHistoryEntry, previous?: SyncHistoryEntry) {
    const load = async (point: SyncHistoryEntry) => {
        const id = point.sharedCheckpoint ?? point.historyCheckpoint;
        if (!id) throw new Error('This sync has no saved state to preview.');
        const snapshot = await engine.loadHistorySnapshot(id, !!point.sharedCheckpoint);
        verify();
        return snapshot;
    };
    const after = await load(entry);
    let before: HistorySnapshot | undefined;
    let notice = 'No earlier state to compare.';
    let retryable = false;
    if (previous) {
        try { before = await load(previous); }
        catch { verify(); retryable = true; notice = 'The earlier saved state could not be loaded. Showing saved contents.'; }
    }
    const comparison = compareHistorySnapshots(after, before, before ? undefined : notice);
    return { ...comparison, retryable, preview: async (path: string) => {
        verify();
        const preview = await comparison.preview(path);
        verify();
        return preview;
    } };
}

/** Preserve pause/persist/apply/sync/verify/resume ordering as one workflow. */
export async function createRuntimeHistoryRestore({ engine, settings, verify, clearForegroundSyncTimer, persistSettings, runSyncOperation }: HistoryRestoreContext,
    entry: SyncHistoryEntry) {
    if (!entry.sharedCheckpoint && (!entry.historyCheckpoint || !settings.syncHistory.some(saved => saved.timestamp === entry.timestamp && saved.type === entry.type && saved.historyCheckpoint === entry.historyCheckpoint))) throw new Error('This history entry has no complete vault checkpoint.');
    let automaticSync = false;
    const review = await engine.createHistoryRestore(entry.sharedCheckpoint ?? entry.historyCheckpoint!, async () => {
        verify();
        automaticSync = settings.automaticSync;
        // Persist the pause before changing files, including across a crash.
        settings.automaticSync = false;
        clearForegroundSyncTimer();
        engine.updateSettings(settings);
        await persistSettings({ automaticSync: false });
        verify();
    }, Boolean(entry.sharedCheckpoint));
    verify();
    return { items: review.items, unchangedCount: review.unchangedCount, preview: async (path: string) => {
        verify();
        const preview = await review.preview(path);
        verify();
        return preview;
    }, restore: async () => {
        verify();
        await review.restore();
        verify();
        if (!review.items.length) return;
        const result = await runSyncOperation(async (current, progress) => {
            const removed = new Set(review.items.filter(item => item.action === 'remove').map(item => item.path));
            const keys = removed.size ? current.getPendingPaths().filter(key => removed.has(key.startsWith('delete:') ? key.slice(7) : key)) : [];
            // The verified local recovery copies allow explicit removals to
            // settle first, freeing paths for historical file/folder renames.
            const deletions = keys.length ? await current.syncSelected(keys) : undefined;
            if (deletions && (!deletions.success || deletions.conflicts.length)) return deletions;
            const synced = await current.sync(progress);
            if (deletions) mergeSyncResults(synced, deletions);
            return synced;
        });
        verify();
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
    } };
}
