import type { SyncHistoryEntry } from '../../sync/types';

export interface HistoryGroup {
    day: string;
    label: string;
    rows: Array<{ entry: SyncHistoryEntry; count: number }>;
}

/** Group only the display; retain every saved sync and its diagnostics. */
export function groupHistory(history: SyncHistoryEntry[], now = new Date()): HistoryGroup[] {
    const today = now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const groups: HistoryGroup[] = [];
    const sorted = [...history].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    for (const entry of sorted) {
        const date = new Date(entry.timestamp);
        const day = date.toDateString();
        let group = groups.at(-1);
        if (group?.day !== day) {
            group = {
                day,
                label: day === today ? 'Today' : day === yesterday.toDateString() ? 'Yesterday'
                    : new Intl.DateTimeFormat(undefined, {
                        month: 'short', day: 'numeric',
                        ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}),
                    }).format(date),
                rows: [],
            };
            groups.push(group);
        }
        const previous = group.rows.at(-1);
        if (previous && previous.entry.type === entry.type && isNoChange(previous.entry) && isNoChange(entry)) {
            previous.count++;
        } else {
            group.rows.push({ entry, count: 1 });
        }
    }
    return groups;
}

function isNoChange(entry: SyncHistoryEntry): boolean {
    return entry.success && !entry.errorCount && !entry.errors?.length
        && !entry.uploaded && !entry.downloaded && !entry.merged && !entry.deleted
        && !entry.conflictCount && !entry.resolvedRaceCount
        && !entry.uploadedPaths?.length && !entry.downloadedPaths?.length
        && !entry.mergedPaths?.length && !entry.deletedPaths?.length
        && !entry.conflictPaths?.length && !entry.resolvedRaces?.length;
}
