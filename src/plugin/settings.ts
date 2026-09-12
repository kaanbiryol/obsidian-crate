/**
 * Settings helpers for Crate.
 */

import { normalizeWorkerUrl } from '../sync/worker-url';
import { normalizeRequestDiagnostics } from '../sync/request-diagnostics';
import type { CloudflareDeploymentMetadata } from '../cloudflare/deployment-types';
import type { ResolvedSyncRace, SyncHistoryEntry } from '../sync/types';
import {
	type CrateSettings,
	DEFAULT_SETTINGS,
	MAX_SYNC_HISTORY,
	MAX_SYNC_HISTORY_PATHS,
} from './settings-types';

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

function normalizeCloudflareDeployment(value: unknown): CloudflareDeploymentMetadata | null {
	if (!isRecord(value)) {
		return null;
	}

	const deploymentId = normalizeString(value.deploymentId).toLowerCase();
	const workerName = normalizeString(value.workerName).toLowerCase();
	const d1DatabaseName = normalizeString(value.d1DatabaseName).toLowerCase();
	const r2BucketName = normalizeString(value.r2BucketName).toLowerCase();
	if (!/^[a-f0-9]{16}$/.test(deploymentId)
		|| !/^crate-[a-f0-9]{16}$/.test(workerName)
		|| !/^crate-[a-f0-9]{16}$/.test(d1DatabaseName)
		|| !/^crate-[a-f0-9]{16}$/.test(r2BucketName)) {
		return null;
	}

	const accountId = normalizeNullableString(value.accountId);
	const d1DatabaseId = normalizeNullableString(value.d1DatabaseId);
	const workersSubdomain = normalizeNullableString(value.workersSubdomain);
	const normalizedFingerprint = normalizeNullableString(value.lastDeployedFingerprint)?.toLowerCase() ?? null;
	const lastDeployedFingerprint = normalizedFingerprint && /^[a-f0-9]{64}$/.test(normalizedFingerprint)
		? normalizedFingerprint
		: null;
	if (accountId !== null && !/^[a-f0-9]{32}$/i.test(accountId)) {
		return null;
	}
	if (d1DatabaseId !== null && !/^[a-f0-9-]{32,36}$/i.test(d1DatabaseId)) {
		return null;
	}
	if (workersSubdomain !== null && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workersSubdomain)) {
		return null;
	}
	return {
		deploymentId,
		accountId,
		accountName: normalizeNullableString(value.accountName),
		workerName,
		d1DatabaseName,
		d1DatabaseId,
		r2BucketName,
		workersSubdomain,
		lastDeployedVersion: normalizeNullableString(value.lastDeployedVersion),
		lastDeployedFingerprint,
		...(isRecord(value.reset) && typeof value.reset.id === 'string' && /^[a-f0-9]{32}$/.test(value.reset.id)
			&& (value.reset.phase === 'clearing' || value.reset.phase === 'rebuilding')
			&& typeof value.reset.databaseId === 'string' && /^[a-f0-9-]{36}$/i.test(value.reset.databaseId)
			&& typeof value.reset.bucketCreatedAt === 'string' && value.reset.bucketCreatedAt.length > 0
			&& typeof value.reset.namespaceId === 'string' && /^[a-f0-9]{32}$/i.test(value.reset.namespaceId)
			? { reset: { id: value.reset.id, phase: value.reset.phase, databaseId: value.reset.databaseId,
				bucketCreatedAt: value.reset.bucketCreatedAt, namespaceId: value.reset.namespaceId,
				...(value.reset.deleteOnly === true ? { deleteOnly: true as const } : {}) } } : {}),
	};
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

	return {
		timestamp,
		type,
		success: value.success,
		uploaded: normalizeNonNegativeInteger(value.uploaded, 0),
		downloaded: normalizeNonNegativeInteger(value.downloaded, 0),
		merged: normalizeNonNegativeInteger(value.merged, 0),
		deleted: normalizeNonNegativeInteger(value.deleted, 0),
		errorCount: normalizeNonNegativeInteger(value.errorCount, 0),
		...(Array.isArray(value.errors) ? {
			errors: value.errors.filter((error): error is string => typeof error === 'string').slice(0, MAX_SYNC_HISTORY_PATHS),
		} : {}),
		conflictCount: normalizeNonNegativeInteger(value.conflictCount, 0),
		...(requestDiagnostics ? { requestDiagnostics } : {}),
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

function ensureConfigDirWorkspaceIgnorePattern(ignorePatterns: string[], configDir: string): string[] {
	const normalizedConfigDir = configDir.replace(/^\/+|\/+$/g, '');
	if (!normalizedConfigDir) {
		return ignorePatterns;
	}

	const workspacePattern = `${normalizedConfigDir}/workspace*`;
	return ignorePatterns.includes(workspacePattern)
		? ignorePatterns
		: [...ignorePatterns, workspacePattern];
}

export function normalizeCrateSettings(
	value: Partial<CrateSettings> | null | undefined,
	configDir: string,
): CrateSettings {
	return {
		...DEFAULT_SETTINGS,
		workerUrl: normalizeWorkerUrl(normalizeString(value?.workerUrl)),
		cloudflareDeployment: normalizeCloudflareDeployment(value?.cloudflareDeployment),
		lastSync: normalizeNullableString(value?.lastSync),
		lastSeq: normalizeNonNegativeInteger(value?.lastSeq, DEFAULT_SETTINGS.lastSeq),
		deviceId: DEFAULT_SETTINGS.deviceId,
		ignorePatterns: ensureConfigDirWorkspaceIgnorePattern(
			normalizeStringArray(value?.ignorePatterns, DEFAULT_SETTINGS.ignorePatterns),
			configDir,
		),
		automaticSync: normalizeBoolean(value?.automaticSync, value?.syncOnStartup === false && value?.syncOnResume === false ? false : DEFAULT_SETTINGS.automaticSync),
		syncOnStartup: normalizeBoolean(value?.syncOnStartup, DEFAULT_SETTINGS.syncOnStartup),
		syncOnResume: normalizeBoolean(value?.syncOnResume, DEFAULT_SETTINGS.syncOnResume),
		syncInterval: normalizeNonNegativeInteger(value?.syncInterval, DEFAULT_SETTINGS.syncInterval),
		showStatusBar: normalizeBoolean(value?.showStatusBar, DEFAULT_SETTINGS.showStatusBar),
		syncHistory: normalizeSyncHistory(value?.syncHistory),
		pushEnabled: normalizeBoolean(value?.pushEnabled, DEFAULT_SETTINGS.pushEnabled),
		debugLogging: normalizeBoolean(value?.debugLogging, DEFAULT_SETTINGS.debugLogging),
		debounceDelay: normalizeNonNegativeInteger(value?.debounceDelay, DEFAULT_SETTINGS.debounceDelay),
	};
}

export function buildPersistedCrateSettings(settings: CrateSettings): Omit<CrateSettings, 'deviceId'> {
	const { deviceId, ...persistedSettings } = settings;
	void deviceId;
	return persistedSettings;
}

export {
	type CrateSettings,
	DEFAULT_SETTINGS,
};
