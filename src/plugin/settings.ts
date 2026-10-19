import { isRecord } from '../platform/validation';
import { validRestoreState } from '../cloudflare/restore/state';
import { normalizeCloudflareDeployment } from '../cloudflare/deployment/state';
import { normalizeReadingSettings } from '../reading/settings';
import { normalizeSyncTimings } from '../sync/timings';
import { normalizeSyncIssues } from '../sync/issues';
/**
 * Settings helpers for Crate.
 */

import { normalizeUsageSnapshot } from '../cloudflare/usage/snapshot';
import { normalizeWorkerUrl } from '../sync/worker-url';
import { normalizeRequestDiagnostics } from '../sync/request-diagnostics';
import type { ResolvedSyncRace, SyncHistoryEntry } from '../sync/types';
import {
	type CrateSettings,
	type PersistedCrateSettings,
	DEFAULT_SETTINGS,
	MAX_SYNC_HISTORY,
	MAX_SYNC_HISTORY_PATHS,
} from './settings-types';

function normalizeString(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value.trim() : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function normalizeNullableString(value: unknown): string | null {
	if (typeof value !== 'string') {
		return null;
	}

	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) {
		return [...fallback];
	}

	const normalized = new Set<string>();
	for (const item of value) {
		if (typeof item !== 'string') {
			continue;
		}

		const trimmed = item.trim();
		if (trimmed.length > 0) {
			normalized.add(trimmed);
		}
	}

	return [...normalized];
}

function normalizeSyncHistoryEntry(value: unknown): SyncHistoryEntry | null {
	if (!isRecord(value)) {
		return null;
	}

	const type = value.type;
	if (type !== 'sync' && type !== 'initial' && type !== 'force') {
		return null;
	}

	const timestamp = normalizeNullableString(value.timestamp);
	if (timestamp === null || typeof value.success !== 'boolean') {
		return null;
	}
	const requestDiagnostics = normalizeRequestDiagnostics(value.requestDiagnostics);
	const timings = normalizeSyncTimings(value.timings);

	return {
		timestamp,
		type,
		success: value.success,
		uploaded: normalizeNonNegativeInteger(value.uploaded, 0),
		downloaded: normalizeNonNegativeInteger(value.downloaded, 0),
		merged: normalizeNonNegativeInteger(value.merged, 0),
		deleted: normalizeNonNegativeInteger(value.deleted, 0),
		errorCount: normalizeNonNegativeInteger(value.errorCount, 0),
		...(Array.isArray(value.issues) ? { issues: normalizeSyncIssues(value.issues, MAX_SYNC_HISTORY_PATHS) } : {}),
		...(Array.isArray(value.errors) ? {
			errors: value.errors.filter((error): error is string => typeof error === 'string').slice(0, MAX_SYNC_HISTORY_PATHS),
		} : {}),
		conflictCount: normalizeNonNegativeInteger(value.conflictCount, 0),
        ...(typeof value.sharedCheckpoint === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.sharedCheckpoint) ? { sharedCheckpoint: value.sharedCheckpoint } : {}),
		...(typeof value.historyCheckpoint === 'string' && /^[a-f0-9]{64}$/.test(value.historyCheckpoint)
			? { historyCheckpoint: value.historyCheckpoint } : {}),
		...(requestDiagnostics ? { requestDiagnostics } : {}),
		...(timings ? { timings } : {}),
		...(typeof value.resolvedRaceCount === 'number' ? {
			resolvedRaceCount: normalizeNonNegativeInteger(value.resolvedRaceCount, 0),
		} : {}),
		...(Array.isArray(value.conflictPaths) ? {
			conflictPaths: normalizeStringArray(value.conflictPaths, []).slice(0, MAX_SYNC_HISTORY_PATHS),
		} : {}),
		...(Array.isArray(value.resolvedRaces) ? {
			resolvedRaces: value.resolvedRaces
				.map(normalizeResolvedSyncRace)
				.filter((race): race is ResolvedSyncRace => race !== null)
				.slice(0, MAX_SYNC_HISTORY_PATHS),
		} : {}),
		uploadedPaths: Array.isArray(value.uploadedPaths)
			? normalizeStringArray(value.uploadedPaths, []).slice(0, MAX_SYNC_HISTORY_PATHS)
			: undefined,
		downloadedPaths: Array.isArray(value.downloadedPaths)
			? normalizeStringArray(value.downloadedPaths, []).slice(0, MAX_SYNC_HISTORY_PATHS)
			: undefined,
		mergedPaths: Array.isArray(value.mergedPaths)
			? normalizeStringArray(value.mergedPaths, []).slice(0, MAX_SYNC_HISTORY_PATHS)
			: undefined,
		deletedPaths: Array.isArray(value.deletedPaths)
			? normalizeStringArray(value.deletedPaths, []).slice(0, MAX_SYNC_HISTORY_PATHS)
			: undefined,
	};
}

function normalizeResolvedSyncRace(value: unknown): ResolvedSyncRace | null {
	if (!isRecord(value) || typeof value.path !== 'string') return null;
	if (value.resolution !== 'kept-local-edit' && value.resolution !== 'kept-remote-edit') return null;
	return { path: value.path, resolution: value.resolution };
}

function normalizeSyncHistory(value: unknown): SyncHistoryEntry[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.map(normalizeSyncHistoryEntry)
		.filter((entry): entry is SyncHistoryEntry => entry !== null)
		.slice(0, MAX_SYNC_HISTORY);
}

function normalizeIgnorePatterns(ignorePatterns: string[], configDir: string): string[] {
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
		syncInterval: normalizeNonNegativeInteger(value?.syncInterval, DEFAULT_SETTINGS.syncInterval),
		syncHistory: normalizeSyncHistory(value?.syncHistory),
		pushEnabled: normalizeBoolean(value?.pushEnabled, DEFAULT_SETTINGS.pushEnabled),
		debugLogging: normalizeBoolean(value?.debugLogging, DEFAULT_SETTINGS.debugLogging),
		debounceDelay: normalizeNonNegativeInteger(value?.debounceDelay, DEFAULT_SETTINGS.debounceDelay),
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
