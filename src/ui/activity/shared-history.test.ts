import { expect, it } from 'vitest';
import { mergeSharedHistory } from './shared-history';
import type { SharedCheckpoint } from '../../protocol/history-checkpoints';
import type { SyncHistoryEntry } from '../../sync/types';
const checkpoint: SharedCheckpoint = { id: '12345678-1234-1234-1234-123456789012', sequence: 5, timestamp: '2026-09-20T10:00:00Z', expiresAt: Date.parse('2026-10-20T10:00:00Z'), fileCount: 20 };
const entry: SyncHistoryEntry = { timestamp: checkpoint.timestamp, type: 'sync', success: true, uploaded: 1, downloaded: 0, merged: 0, deleted: 0, errorCount: 0, conflictCount: 0, sharedCheckpoint: checkpoint.id };
it('shows server checkpoints on a device with no local history', () => {
    expect(mergeSharedHistory([], [checkpoint])).toEqual([expect.objectContaining({ sharedCheckpoint: checkpoint.id, checkpointFileCount: 20 })]);
});
it('keeps local details without duplicating the same shared state', () => {
    expect(mergeSharedHistory([entry, { ...entry }], [checkpoint])).toEqual([entry]);
});
it('removes restore actions for checkpoints evicted from the authoritative index', () => {
    expect(mergeSharedHistory([entry], [])[0]?.sharedCheckpoint).toBeUndefined();
    expect(entry.sharedCheckpoint).toBe(checkpoint.id);
});
