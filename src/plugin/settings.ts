import { normalizeNonNegativeInteger, normalizeNullableString, normalizeStringArray } from '../platform/validation';
import { validRestoreState } from '../cloudflare/restore/state';
import { normalizeCloudflareDeployment } from '../cloudflare/deployment/state';
import { normalizeReadingSettings } from '../reading/settings';
/**
 * Settings helpers for Crate.
 */

import { normalizeUsageSnapshot } from '../cloudflare/usage/snapshot';
import { normalizeWorkerUrl } from '../sync/connection/worker-url';
import { type CrateSettings, type PersistedCrateSettings, DEFAULT_SETTINGS } from './settings-types';
import { normalizeSyncHistory } from '../sync/settings';
import { MAX_SYNC_INTERVAL_SECONDS, normalizeSharedSettingsValue } from '../protocol/shared-settings';

function normalizeString(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value.trim() : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

/** Every device also excludes its own workspace files, whatever its shared patterns say. */
export function normalizeIgnorePatterns(ignorePatterns: string[], configDir: string): string[] {
	const normalizedConfigDir = configDir.replace(/^\/+|\/+$/g, '');
	const workspacePattern = normalizedConfigDir ? `${normalizedConfigDir}/workspace*` : null;
	return !workspacePattern || ignorePatterns.includes(workspacePattern)
		? ignorePatterns
		: [...ignorePatterns, workspacePattern];
}

export function normalizePersistedCrateSettings(
	value: Partial<PersistedCrateSettings> | null | undefined,
	configDir: string,
): PersistedCrateSettings {
	const workerUrl = normalizeWorkerUrl(normalizeString(value?.workerUrl));
	const scopeUrl = normalizeWorkerUrl(normalizeString(value?.checkpointScope?.workerUrl));
	const authority = normalizeWorkerUrl(normalizeString(value?.checkpointScope?.authority));
	// The shared settings base belongs to one server; another address starts from local settings.
	const sharedBaseUrl = normalizeWorkerUrl(normalizeString(value?.sharedSettingsBase?.workerUrl));
	const sharedBase = workerUrl && sharedBaseUrl === workerUrl ? normalizeSharedSettingsValue(value?.sharedSettingsBase?.settings) : null;
	return {
		reading: normalizeReadingSettings(value?.reading),
		usageSnapshot: normalizeUsageSnapshot(value?.usageSnapshot),
		workerUrl,
		...(workerUrl && scopeUrl === workerUrl && authority ? { checkpointScope: { workerUrl, authority } } : {}),
		cloudflareDeployment: normalizeCloudflareDeployment(value?.cloudflareDeployment),
		cloudflareRestore: validRestoreState(value?.cloudflareRestore) ? structuredClone(value.cloudflareRestore) : null,
		lastSync: normalizeNullableString(value?.lastSync),
		lastSeq: normalizeNonNegativeInteger(value?.lastSeq, DEFAULT_SETTINGS.lastSeq),
		ignorePatterns: normalizeIgnorePatterns(
			normalizeStringArray(value?.ignorePatterns, DEFAULT_SETTINGS.ignorePatterns),
			configDir,
		),
		automaticSync: normalizeBoolean(value?.automaticSync, DEFAULT_SETTINGS.automaticSync),
		syncInterval: Math.min(normalizeNonNegativeInteger(value?.syncInterval, DEFAULT_SETTINGS.syncInterval), MAX_SYNC_INTERVAL_SECONDS),
		syncHistory: normalizeSyncHistory(value?.syncHistory),
		pushEnabled: normalizeBoolean(value?.pushEnabled, DEFAULT_SETTINGS.pushEnabled),
		debugLogging: normalizeBoolean(value?.debugLogging, DEFAULT_SETTINGS.debugLogging),
		debounceDelay: normalizeNonNegativeInteger(value?.debounceDelay, DEFAULT_SETTINGS.debounceDelay),
		...(sharedBase ? { sharedSettingsBase: { workerUrl, settings: sharedBase } } : {}),
	};
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
