import { MAX_SYNC_HISTORY, type CrateSettings, type PersistedCrateSettings } from './settings-types';

/** Publish only the fields owned by this completed write, never its whole snapshot. */
export function publishSavedSettings(
	settings: CrateSettings,
	requested: Partial<PersistedCrateSettings>,
	saved: PersistedCrateSettings,
): void {
	const keys = new Set(Object.keys(requested));
	// The checkpoint alias is valid only for its saved transport address.
	if (keys.has('workerUrl')) keys.add('checkpointScope');
	for (const key of keys) {
		if (key === 'checkpointScope' && saved.checkpointScope === undefined) {
			delete settings.checkpointScope;
		} else if (Object.hasOwn(saved, key)) {
			Object.assign(settings, { [key]: saved[key as keyof PersistedCrateSettings] });
		}
	}
}

type SyncProgressUpdate = Partial<Pick<PersistedCrateSettings, 'lastSeq' | 'lastSync'>> & {
	syncHistory?: readonly CrateSettings['syncHistory'][number][];
};

/** Sync publishes progress synchronously; the runtime persists it after checkpoint work.
 * Replacing history keeps already dispatched settings snapshots stable.
 */
export function updateSyncProgress(settings: CrateSettings, update: SyncProgressUpdate): void {
	if (update.lastSeq !== undefined) settings.lastSeq = update.lastSeq;
	if (update.lastSync !== undefined) settings.lastSync = update.lastSync;
	if (update.syncHistory) settings.syncHistory = update.syncHistory.slice(0, MAX_SYNC_HISTORY);
}
