import type { CrateSettings, PersistedCrateSettings } from './settings-types';

/** Publish only the fields owned by this completed write, never its whole snapshot. */
export function publishSavedSettings(
	settings: CrateSettings,
	requested: Partial<PersistedCrateSettings>,
	saved: PersistedCrateSettings,
): void {
	const keys = new Set(Object.keys(requested));
	// The checkpoint alias and shared settings base are valid only for their saved transport address.
	if (keys.has('workerUrl')) {
		keys.add('checkpointScope');
		keys.add('sharedSettingsBase');
	}
	for (const key of keys) {
		if ((key === 'checkpointScope' || key === 'sharedSettingsBase') && saved[key] === undefined) {
			delete settings[key];
		} else if (Object.hasOwn(saved, key)) {
			Object.assign(settings, { [key]: saved[key as keyof PersistedCrateSettings] });
		}
	}
}
