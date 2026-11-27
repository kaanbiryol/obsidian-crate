import type { SyncHistoryEntry, SyncResult } from '../types';
import { getSyncIssues } from '../issues';
import { MAX_SYNC_HISTORY, MAX_SYNC_HISTORY_PATHS, updateSyncProgress, type SyncSettings } from '../settings';
import type { RequestDiagnostic, RequestDiagnostics } from '../diagnostics/request-diagnostics';
import type { UploadDiagnostic } from '../diagnostics/upload-diagnostics';

const requestKey = (row: RequestDiagnostic) => `${row.at}|${row.operationId}|${row.method}|${row.route}`;
const uploadKey = (row: UploadDiagnostic) => `${row.at}|${row.operationId}|${row.phase}|${row.pathHash}`;

/** The diagnostic rows no kept entry holds. The request and upload logs are rolling
 * windows, so storing each whole window would repeat most rows in every entry. */
function newDiagnostics(history: readonly SyncHistoryEntry[], diagnostics: RequestDiagnostics): RequestDiagnostics {
	const requests = new Set<string>(), uploads = new Set<string>();
	for (const entry of history) {
		for (const row of entry.requestDiagnostics?.requests ?? []) requests.add(requestKey(row));
		for (const row of entry.requestDiagnostics?.uploads ?? []) uploads.add(uploadKey(row));
	}
	return { ...diagnostics, requests: diagnostics.requests.filter(row => !requests.has(requestKey(row))),
		...(diagnostics.uploads ? { uploads: diagnostics.uploads.filter(row => !uploads.has(uploadKey(row))) } : {}) };
}

export function recordSyncHistory(
	settings: SyncSettings,
	type: SyncHistoryEntry["type"],
	result: SyncResult,
	details: Pick<SyncHistoryEntry, 'timings' | 'requestDiagnostics'> = {},
): SyncHistoryEntry {
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
		...(result.errors.length ? { issues: getSyncIssues(result).slice(0, MAX_SYNC_HISTORY_PATHS) } : {}),
		conflictCount: result.conflicts.length,
		resolvedRaceCount: result.resolvedRaces.length,
		conflictPaths: limitHistoryPaths(result.conflicts),
		resolvedRaces: result.resolvedRaces.slice(0, MAX_SYNC_HISTORY_PATHS),
		uploadedPaths: limitHistoryPaths(result.uploadedPaths),
		downloadedPaths: limitHistoryPaths(result.downloadedPaths),
		mergedPaths: limitHistoryPaths(result.mergedPaths),
		deletedPaths: limitHistoryPaths(result.deletedPaths),
		...details.timings ? { timings: details.timings } : {},
		// The oldest entry is dropped below, so its rows count as new.
		...details.requestDiagnostics ? { requestDiagnostics: newDiagnostics(settings.syncHistory.slice(0, MAX_SYNC_HISTORY - 1), details.requestDiagnostics) } : {},
	};

	updateSyncProgress(settings, { syncHistory: [entry, ...settings.syncHistory] });
	return entry;
}

export function resetStoredSyncState(settings: SyncSettings): void {
	delete settings.checkpointScope;
	delete settings.serverStorageId;
	settings.replaceVault = false;
	updateSyncProgress(settings, { lastSeq: 0, lastSync: null, syncHistory: [] });
}

function limitHistoryPaths(paths: string[] = []): string[] {
	return paths.slice(0, MAX_SYNC_HISTORY_PATHS);
}
