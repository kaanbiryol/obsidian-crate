import type { SyncHistoryEntry } from './types';

/** Persisted plugin settings that sync owns; plugin settings compose this slice. */
export interface PersistedSyncSettings {
	automaticSync: boolean;
	workerUrl: string;
	/** Retain local journals only across an authenticated address change of the same vault. */
	checkpointScope?: { workerUrl: string; authority: string };
	lastSync: string | null;
	lastSeq: number;
	ignorePatterns: string[];
	syncInterval: number;
	syncHistory: SyncHistoryEntry[];
	debounceDelay: number;
	/** Replicated to other devices through shared settings. */
	pushEnabled: boolean;
}

export interface SyncSettings extends PersistedSyncSettings {
	/** Hydrated from local secret storage; never loaded from or saved to plugin data. */
	deviceId: string;
}

export const MAX_SYNC_HISTORY = 20;
export const MAX_SYNC_HISTORY_PATHS = 50;
export const MAX_DEBOUNCE_WAIT_MS = 30_000;

type SyncProgressUpdate = Partial<Pick<PersistedSyncSettings, 'lastSeq' | 'lastSync'>> & {
	syncHistory?: readonly SyncHistoryEntry[];
};

/** Sync publishes progress synchronously; the runtime persists it after checkpoint work.
 * Replacing history keeps already dispatched settings snapshots stable.
 */
export function updateSyncProgress(settings: SyncSettings, update: SyncProgressUpdate): void {
	if (update.lastSeq !== undefined) settings.lastSeq = update.lastSeq;
	if (update.lastSync !== undefined) settings.lastSync = update.lastSync;
	if (update.syncHistory) settings.syncHistory = update.syncHistory.slice(0, MAX_SYNC_HISTORY);
}
