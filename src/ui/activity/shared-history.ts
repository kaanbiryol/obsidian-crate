import type { SharedCheckpoint } from '../../protocol/history-checkpoints';
import type { SyncHistoryEntry } from '../../sync/types';

/** One row per shared state, keeping this device's transfer details when available. */
export function mergeSharedHistory(local: SyncHistoryEntry[], shared: SharedCheckpoint[]): SyncHistoryEntry[] {
    const ids = new Set(shared.map(checkpoint => checkpoint.id));
    return [
        ...shared.map(checkpoint => {
            const own = local.find(entry => entry.sharedCheckpoint === checkpoint.id && (entry.uploaded || entry.downloaded || entry.merged || entry.deleted))
                ?? local.find(entry => entry.sharedCheckpoint === checkpoint.id);
            return own ? { ...own, timestamp: checkpoint.timestamp } : {
                timestamp: checkpoint.timestamp, sharedCheckpoint: checkpoint.id, checkpointFileCount: checkpoint.fileCount,
                type: 'sync' as const, success: true, uploaded: 0, downloaded: 0, merged: 0, deleted: 0, errorCount: 0, conflictCount: 0,
            };
        }),
        ...local.filter(entry => !entry.sharedCheckpoint || !ids.has(entry.sharedCheckpoint)).map(entry => {
            // A successful server listing is authoritative about expiry/eviction.
            if (!entry.sharedCheckpoint) return entry;
            const { sharedCheckpoint: _expired, ...rest } = entry;
            return rest;
        }),
    ];
}
