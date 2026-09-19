import { describe, expect, it } from 'vitest';
import type { SyncHistoryEntry } from '../../sync/types';
import { groupHistory } from './history-groups';

const now = new Date(2026, 8, 19, 15);
function entry(day: number, hour: number, overrides: Partial<SyncHistoryEntry> = {}): SyncHistoryEntry {
    return { timestamp: new Date(2026, 8, day, hour).toISOString(), type: 'sync', success: true,
        uploaded: 0, downloaded: 0, merged: 0, deleted: 0, errorCount: 0, conflictCount: 0, ...overrides };
}

describe('history grouping', () => {
    it('collapses consecutive no-op syncs and keeps the latest timestamp without mutating history', () => {
        const history = [entry(19, 12), entry(19, 14), entry(19, 13)];
        const original = structuredClone(history);
        const groups = groupHistory(history, now);
        expect(groups[0]?.rows).toEqual([{ entry: history[1], count: 3 }]);
        expect(history).toEqual(original);
    });

    it('separates local days and uses time-relative headings', () => {
        const groups = groupHistory([entry(19, 14), entry(18, 14), entry(17, 14)], now);
        expect(groups.map(group => group.label)).toEqual(['Today', 'Yesterday',
            new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(2026, 8, 17))]);
        expect(groups.map(group => group.rows[0]?.count)).toEqual([1, 1, 1]);
    });

    it.each([
        { uploaded: 1 }, { success: false, errorCount: 1 }, { conflictCount: 1 },
        { resolvedRaceCount: 1 }, { uploadedPaths: ['Note.md'] }, { errors: ['Failed'] },
        { type: 'initial' as const },
    ])('does not collapse across significant entries: %j', overrides => {
        const groups = groupHistory([entry(19, 14), entry(19, 13, overrides), entry(19, 12)], now);
        expect(groups[0]?.rows).toHaveLength(3);
    });
});
