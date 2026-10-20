import type { CrateSettings, PersistedCrateSettings } from './settings-types';

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
