import { MAX_SYNC_HISTORY, MAX_SYNC_HISTORY_PATHS, type CrateSettings } from '../plugin/settings-types';
import type { SyncHistoryEntry, SyncResult } from './types';

export function recordSyncHistory(
  settings: CrateSettings,
  type: SyncHistoryEntry["type"],
  result: SyncResult,
): void {
  const entry: SyncHistoryEntry = {
    timestamp: new Date().toISOString(),
    type,
    success: result.success,
    uploaded: result.uploaded,
    downloaded: result.downloaded,
    merged: result.merged,
    deleted: result.deleted,
    errorCount: result.errors.length,
    errors: limitHistoryPaths(result.errors),
    conflictCount: result.conflicts.length,
    resolvedRaceCount: result.resolvedRaces.length,
    conflictPaths: limitHistoryPaths(result.conflicts),
    resolvedRaces: result.resolvedRaces.slice(0, MAX_SYNC_HISTORY_PATHS),
    uploadedPaths: limitHistoryPaths(result.uploadedPaths),
    downloadedPaths: limitHistoryPaths(result.downloadedPaths),
    mergedPaths: limitHistoryPaths(result.mergedPaths),
    deletedPaths: limitHistoryPaths(result.deletedPaths),
  };

  settings.syncHistory.unshift(entry);
  if (settings.syncHistory.length > MAX_SYNC_HISTORY) {
    settings.syncHistory.length = MAX_SYNC_HISTORY;
  }
}

export function resetStoredSyncState(settings: CrateSettings): void {
  settings.lastSeq = 0;
  settings.lastSync = null;
  settings.syncHistory = [];
}

function limitHistoryPaths(paths: string[] = []): string[] {
  return paths.slice(0, MAX_SYNC_HISTORY_PATHS);
}
