import { isRecord, isSha256Hex, normalizeNonNegativeInteger, normalizeNullableString, normalizeStringArray } from '../platform/validation';
import { MAX_TIMER_SECONDS } from '../protocol/shared-settings';
import { isCheckpointId } from '../protocol/history-checkpoints';
import { normalizeWorkerUrl } from './connection/worker-url';
import { normalizeSyncTimings } from './diagnostics/timings';
import { normalizeRequestDiagnostics } from './diagnostics/request-diagnostics';
import { normalizeSyncIssues } from './issues';
import type { ResolvedSyncRace, SyncHistoryEntry } from './types';

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

/** Identity fields sync reads from a Crate-managed Cloudflare deployment. */
interface ManagedServerIdentity {
	accountId: string | null;
	workerName: string;
	d1DatabaseId: string | null;
}

/** The runtime's view of plugin settings: sync fields plus whether Crate manages the server. */
export interface SyncRuntimeSettings extends SyncSettings {
	cloudflareDeployment: ManagedServerIdentity | null;
}

export const DEFAULT_SYNC_SETTINGS: PersistedSyncSettings = {
	automaticSync: false,
	workerUrl: '',
	lastSync: null,
	lastSeq: 0,
	ignorePatterns: ['.git/', '.trash/', '*.tmp', '.DS_Store', '._*', 'Thumbs.db', 'desktop.ini', '*.swp', '*.swo'],
	syncInterval: 300,
	syncHistory: [],
	pushEnabled: false,
	debounceDelay: 5,
};

/** Every device also excludes its own workspace files, whatever its shared patterns say. */
export function normalizeIgnorePatterns(ignorePatterns: string[], configDir: string): string[] {
	const normalizedConfigDir = configDir.replace(/^\/+|\/+$/g, '');
	const workspacePattern = normalizedConfigDir ? `${normalizedConfigDir}/workspace*` : null;
	return !workspacePattern || ignorePatterns.includes(workspacePattern)
		? ignorePatterns
		: [...ignorePatterns, workspacePattern];
}

const normalizeString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const normalizeBoolean = (value: unknown, fallback: boolean): boolean => typeof value === 'boolean' ? value : fallback;

export function normalizePersistedSyncSettings(
	value: Partial<PersistedSyncSettings> | null | undefined,
	configDir: string,
): PersistedSyncSettings {
	const defaults = DEFAULT_SYNC_SETTINGS;
	const workerUrl = normalizeWorkerUrl(normalizeString(value?.workerUrl));
	const scopeUrl = normalizeWorkerUrl(normalizeString(value?.checkpointScope?.workerUrl));
	const authority = normalizeWorkerUrl(normalizeString(value?.checkpointScope?.authority));
	return {
		workerUrl,
		...(workerUrl && scopeUrl === workerUrl && authority ? { checkpointScope: { workerUrl, authority } } : {}),
		lastSync: normalizeNullableString(value?.lastSync),
		lastSeq: normalizeNonNegativeInteger(value?.lastSeq, defaults.lastSeq),
		ignorePatterns: normalizeIgnorePatterns(normalizeStringArray(value?.ignorePatterns, defaults.ignorePatterns), configDir),
		automaticSync: normalizeBoolean(value?.automaticSync, defaults.automaticSync),
		syncInterval: Math.min(normalizeNonNegativeInteger(value?.syncInterval, defaults.syncInterval), MAX_TIMER_SECONDS),
		syncHistory: normalizeSyncHistory(value?.syncHistory),
		pushEnabled: normalizeBoolean(value?.pushEnabled, defaults.pushEnabled),
		debounceDelay: Math.min(normalizeNonNegativeInteger(value?.debounceDelay, defaults.debounceDelay), MAX_TIMER_SECONDS),
	};
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
		...(isCheckpointId(value.sharedCheckpoint) ? { sharedCheckpoint: value.sharedCheckpoint } : {}),
		...(isSha256Hex(value.historyCheckpoint)
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

/** Drops malformed entries and caps persisted history so settings payloads stay small. */
export function normalizeSyncHistory(value: unknown): SyncHistoryEntry[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.map(normalizeSyncHistoryEntry)
		.filter((entry): entry is SyncHistoryEntry => entry !== null)
		.slice(0, MAX_SYNC_HISTORY);
}
