import type { SyncHistoryEntry, SyncResult } from '../types';
import { getSyncIssues } from '../issues';
import { MAX_SYNC_HISTORY_PATHS, updateSyncProgress, type SyncSettings } from '../settings';
import { createLogger } from '../logger';
import { errorMessage } from '../../platform/logger';

const logger = createLogger('SyncRuntime');

const CHECKPOINT_INTERVAL_PER_FILE_MS = 360;

/** A checkpoint reads the whole server inventory. Ordinary syncs space them by
 * vault size, about 2.4 inventory reads a day at any size (100,000 files: every
 * 10 hours; 1,000 files: every 6 minutes). Initial and full syncs always save one. */
export function checkpointDue(input: {
	type: SyncHistoryEntry['type'];
	history: readonly SyncHistoryEntry[];
	latest: SyncHistoryEntry;
	/** Survives entries that fall out of the 20-entry history window. */
	lastCheckpointAt: number;
	trackedFiles: number;
	now: number;
}): boolean {
	if (input.type !== 'sync') return true;
	const previous = input.history.find(entry => entry !== input.latest && entry.sharedCheckpoint && entry.checkpointFileCount === undefined);
	const last = Math.max(previous ? Date.parse(previous.timestamp) : 0, input.lastCheckpointAt);
	return !last || input.now - last >= input.trackedFiles * CHECKPOINT_INTERVAL_PER_FILE_MS;
}

/** Saves a shared history checkpoint after a successful sync once one is due. */
export class SharedCheckpointSchedule {
	private lastCheckpointAt = 0;

	async saveIfDue(
		settings: SyncSettings,
		type: SyncHistoryEntry['type'],
		result: SyncResult,
		latest: SyncHistoryEntry,
		engine: { trackedFileCount(): number; saveSharedHistoryCheckpoint(): Promise<{ id: string } | undefined> },
		isCurrent: () => boolean,
	): Promise<void> {
		if (!result.success || result.conflicts.length || !checkpointDue({
			type, history: settings.syncHistory, latest, lastCheckpointAt: this.lastCheckpointAt,
			trackedFiles: engine.trackedFileCount(), now: Date.now(),
		})) return;
		// The server rejects vaults above the shared limits; they get no checkpoint. A failed
		// attempt waits as long as a saved one, so it is not retried after every sync.
		this.lastCheckpointAt = Date.now();
		try {
			const shared = await engine.saveSharedHistoryCheckpoint();
			if (!isCurrent() || !shared) return;
			updateSyncProgress(settings, { syncHistory: settings.syncHistory.map(entry => entry === latest ? { ...entry, sharedCheckpoint: shared.id } : entry) });
		}
		catch (error) { if (isCurrent()) logger.warn('Could not save the history checkpoint:', errorMessage(error)); }
	}
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
		...details,
	};

	updateSyncProgress(settings, { syncHistory: [entry, ...settings.syncHistory] });
	return entry;
}

export function resetStoredSyncState(settings: SyncSettings): void {
	delete settings.checkpointScope;
	settings.replaceVault = false;
	updateSyncProgress(settings, { lastSeq: 0, lastSync: null, syncHistory: [] });
}

function limitHistoryPaths(paths: string[] = []): string[] {
	return paths.slice(0, MAX_SYNC_HISTORY_PATHS);
}
