/**
 * Settings helpers for Crate.
 */

import { normalizeWorkerUrl } from '../sync/worker-url';
import {
	type CrateSettings,
	DEFAULT_SETTINGS,
	MAX_SYNC_HISTORY,
	MAX_SYNC_HISTORY_PATHS,
	type SyncHistoryEntry,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value.trim() : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function normalizeNullableTimestamp(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

	return {
		timestamp,
		type,
		success: value.success,
		uploaded: normalizeNonNegativeInteger(value.uploaded, 0),
		downloaded: normalizeNonNegativeInteger(value.downloaded, 0),
		deleted: normalizeNonNegativeInteger(value.deleted, 0),
		errorCount: normalizeNonNegativeInteger(value.errorCount, 0),
		conflictCount: normalizeNonNegativeInteger(value.conflictCount, 0),
		uploadedPaths: Array.isArray(value.uploadedPaths)
			? normalizeStringArray(value.uploadedPaths, []).slice(0, MAX_SYNC_HISTORY_PATHS)
			: undefined,
		downloadedPaths: Array.isArray(value.downloadedPaths)
			? normalizeStringArray(value.downloadedPaths, []).slice(0, MAX_SYNC_HISTORY_PATHS)
			: undefined,
		deletedPaths: Array.isArray(value.deletedPaths)
			? normalizeStringArray(value.deletedPaths, []).slice(0, MAX_SYNC_HISTORY_PATHS)
			: undefined,
	};
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
		cloudflareAccountId: normalizeString(value?.cloudflareAccountId),
		cloudflareTokenExpiresAt: normalizeNullableTimestamp(value?.cloudflareTokenExpiresAt),
		workerName: normalizeString(value?.workerName),
		bucketName: normalizeString(value?.bucketName),
		databaseId: normalizeString(value?.databaseId),
		lastSync: normalizeNullableString(value?.lastSync),
		lastSeq: normalizeNonNegativeInteger(value?.lastSeq, DEFAULT_SETTINGS.lastSeq),
		deviceId: normalizeString(value?.deviceId),
		ignorePatterns: ensureConfigDirWorkspaceIgnorePattern(
			normalizeStringArray(value?.ignorePatterns, DEFAULT_SETTINGS.ignorePatterns),
			configDir,
		),
		syncOnStartup: normalizeBoolean(value?.syncOnStartup, DEFAULT_SETTINGS.syncOnStartup),
		syncInterval: normalizeNonNegativeInteger(value?.syncInterval, DEFAULT_SETTINGS.syncInterval),
		showStatusBar: normalizeBoolean(value?.showStatusBar, DEFAULT_SETTINGS.showStatusBar),
		syncHistory: normalizeSyncHistory(value?.syncHistory),
		pushEnabled: normalizeBoolean(value?.pushEnabled, DEFAULT_SETTINGS.pushEnabled),
	};
}

export {
	type CrateSettings,
	DEFAULT_SETTINGS,
};
