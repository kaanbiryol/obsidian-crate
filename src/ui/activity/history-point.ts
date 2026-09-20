import type { SyncHistoryEntry } from '../../sync/types';

export function historyPointLabel(entry: SyncHistoryEntry): string {
    const id = entry.sharedCheckpoint ?? entry.historyCheckpoint;
    return id ? `Restore point ${id.slice(0, 8)}` : 'Sync activity';
}

export function historyEntryKey(entry: SyncHistoryEntry): string {
    return `${entry.timestamp}:${entry.type}:${entry.sharedCheckpoint ?? entry.historyCheckpoint ?? ''}`;
}
