import type { SyncHistoryEntry } from '../../sync/types';

export function describeHistory(entry: SyncHistoryEntry, count = 1): string {
    if (entry.checkpointFileCount !== undefined) return `Saved state · ${entry.checkpointFileCount.toLocaleString()} files`;
    const metrics = [
        [entry.uploaded, 'Uploaded'], [entry.downloaded, 'Downloaded'], [entry.merged, 'Merged'], [entry.deleted, 'Deleted'],
        [entry.conflictCount, 'Conflicts'], [entry.resolvedRaceCount ?? 0, 'Races resolved'],
    ] as const;
    const changes = metrics.filter(([total]) => total > 0).map(([total, label]) => `${label} ${total.toLocaleString()}`);
    if (changes.length === 1 && !entry.conflictCount && !entry.resolvedRaceCount) changes[0] += entry.uploaded + entry.downloaded + entry.merged + entry.deleted === 1 ? ' file' : ' files';
    if (!entry.success) changes.unshift(`Failed (${entry.errorCount} ${entry.errorCount === 1 ? 'error' : 'errors'})`);
    return changes.join(' · ') || (count > 1 ? `No changes · ${count} checks` : 'No changes');
}

export function historyTime(entry: SyncHistoryEntry): string {
    return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(entry.timestamp));
}

/** Activity metadata is a fallback, never evidence of historical file contents. */
export function recordedHistoryFiles(entry: SyncHistoryEntry): Array<{ path: string; action: string }> {
    const groups = [
        [entry.uploadedPaths, 'Uploaded'], [entry.downloadedPaths, 'Downloaded'], [entry.mergedPaths, 'Merged'],
        [entry.deletedPaths, 'Deleted'], [entry.conflictPaths, 'Conflict'],
        [entry.resolvedRaces?.filter(race => race.resolution === 'kept-local-edit').map(race => race.path), 'Kept local edit'],
        [entry.resolvedRaces?.filter(race => race.resolution === 'kept-remote-edit').map(race => race.path), 'Restored remote edit'],
    ] as const;
    return [...new Map(groups.flatMap(([paths, action]) => (paths ?? []).map(path => [path, { path, action }] as const))).values()];
}
