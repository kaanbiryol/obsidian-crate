import { expect, it } from 'vitest';
import type { SyncHistoryEntry } from '../../sync/types';
import { describeHistory, historyTime, recordedHistoryFiles } from './history';

const entry: SyncHistoryEntry = { timestamp: '2026-09-20T10:18:42Z', type: 'sync', success: true,
    uploaded: 2, downloaded: 0, merged: 0, deleted: 0, errorCount: 0, conflictCount: 0,
    uploadedPaths: ['Today.md', 'Upcoming.md'] };

it('summarizes transfers without filenames or restore IDs', () => {
    expect(describeHistory({ ...entry, sharedCheckpoint: '12345678' })).toBe('Uploaded 2 files');
    expect(describeHistory({ ...entry, uploaded: 1 })).toBe('Uploaded 1 file');
    expect(describeHistory({ ...entry, downloaded: 3, deleted: 1 })).toBe('Uploaded 2 · Downloaded 3 · Deleted 1');
});
it('keeps errors, conflicts and resolved races visible', () => {
    expect(describeHistory({ ...entry, success: false, errorCount: 2, conflictCount: 1, resolvedRaceCount: 1 }))
        .toBe('Failed (2 errors) · Uploaded 2 · Conflicts 1 · Races resolved 1');
});
it('labels shared states and repeated no-change checks', () => {
    expect(describeHistory({ ...entry, checkpointFileCount: 120 })).toBe('Saved state · 120 files');
    expect(describeHistory({ ...entry, uploaded: 0 })).toBe('No changes');
    expect(describeHistory({ ...entry, uploaded: 0 }, 3)).toBe('No changes · 3 checks');
});
it('distinguishes entries within the same minute', () => {
    expect(historyTime(entry)).toMatch(/:18:42$/);
    expect(historyTime({ ...entry, timestamp: '2026-09-20T10:18:07Z' })).toMatch(/:18:07$/);
});
it('retains recorded paths for entries without a saved snapshot', () => {
    expect(recordedHistoryFiles({ ...entry, downloadedPaths: ['Folder/Downloaded.md'], deletedPaths: ['Old.md'], conflictPaths: ['Today.md'] }))
        .toEqual([{ path: 'Today.md', action: 'Conflict' }, { path: 'Upcoming.md', action: 'Uploaded' }, { path: 'Folder/Downloaded.md', action: 'Downloaded' }, { path: 'Old.md', action: 'Deleted' }]);
    expect(recordedHistoryFiles({ ...entry, uploaded: 400, uploadedPaths: [] })).toEqual([]);
    expect(recordedHistoryFiles({ ...entry, uploadedPaths: [], resolvedRaces: [{ path: 'Race.md', resolution: 'kept-local-edit' }] }))
        .toEqual([{ path: 'Race.md', action: 'Kept local edit' }]);
});
