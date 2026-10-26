import { validRestoreState } from '../cloudflare/restore/state';
import { normalizeCloudflareDeployment } from '../cloudflare/deployment/state';
import { normalizeReadingSettings } from '../reading/settings';
/**
 * Settings helpers for Crate.
 */

import { normalizeUsageSnapshot } from '../cloudflare/usage/snapshot';
import { normalizeWorkerUrl } from '../sync/connection/worker-url';
import { type CrateSettings, type PersistedCrateSettings, DEFAULT_SETTINGS } from './settings-types';
import { normalizePersistedSyncSettings } from '../sync/settings';
import { normalizeSharedSettingsValue } from '../protocol/shared-settings';

export function normalizePersistedCrateSettings(
	value: Partial<PersistedCrateSettings> | null | undefined,
	configDir: string,
): PersistedCrateSettings {
	const sync = normalizePersistedSyncSettings(value, configDir);
	const { workerUrl } = sync;
	// The shared settings base belongs to one server; another address starts from local settings.
	const sharedBaseUrl = typeof value?.sharedSettingsBase?.workerUrl === 'string' ? normalizeWorkerUrl(value.sharedSettingsBase.workerUrl.trim()) : '';
	const sharedBase = workerUrl && sharedBaseUrl === workerUrl ? normalizeSharedSettingsValue(value?.sharedSettingsBase?.settings) : null;
	return {
		...sync,
		reading: normalizeReadingSettings(value?.reading),
		usageSnapshot: normalizeUsageSnapshot(value?.usageSnapshot),
		cloudflareDeployment: normalizeCloudflareDeployment(value?.cloudflareDeployment),
		cloudflareRestore: validRestoreState(value?.cloudflareRestore) ? structuredClone(value.cloudflareRestore) : null,
		debugLogging: typeof value?.debugLogging === 'boolean' ? value.debugLogging : DEFAULT_SETTINGS.debugLogging,
		...(sharedBase ? { sharedSettingsBase: { workerUrl, settings: sharedBase } } : {}),
	};
}

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

/** Initialize runtime settings before hydrating this device's local identity. */
export function normalizeCrateSettings(
	value: Partial<CrateSettings> | null | undefined,
	configDir: string,
): CrateSettings {
	return { ...normalizePersistedCrateSettings(value, configDir), deviceId: DEFAULT_SETTINGS.deviceId };
}

export function buildPersistedCrateSettings(settings: CrateSettings): PersistedCrateSettings {
	const { deviceId, ...persistedSettings } = settings;
	void deviceId;
	return persistedSettings;
}

export {
	type CrateSettings,
	type PersistedCrateSettings,
	DEFAULT_SETTINGS,
};
