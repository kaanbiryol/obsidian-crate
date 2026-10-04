import type { ServerRestoreState } from '../cloudflare/restore/state';
import type { UsageSnapshot } from '../cloudflare/usage-snapshot';
import type { CloudflareDeploymentMetadata } from '../cloudflare/deployment-types';
import type { SyncHistoryEntry } from '../sync/types';
import { DEFAULT_READING_SETTINGS, type ReadingSettings } from '../reading/settings';

export interface CrateSettings {
	cloudflareRestore?: ServerRestoreState | null;
	reading: ReadingSettings;
	usageSnapshot?: UsageSnapshot | null;
	automaticSync: boolean;
	workerUrl: string;
	/** Retain local journals only across an authenticated address change of the same vault. */
	checkpointScope?: { workerUrl: string; authority: string };
	cloudflareDeployment: CloudflareDeploymentMetadata | null;
	lastSync: string | null;
	lastSeq: number;
	deviceId: string;
	ignorePatterns: string[];
	syncOnStartup: boolean;
	syncOnResume: boolean;
	syncInterval: number;
	syncHistory: SyncHistoryEntry[];
	pushEnabled: boolean;
	debugLogging: boolean;
	debounceDelay: number;
}

export interface SharedSettings {
	ignorePatterns: string[];
	syncOnStartup: boolean;
	syncOnResume: boolean;
	syncInterval: number;
	pushEnabled: boolean;
}

export const DEFAULT_SETTINGS: CrateSettings = {
	reading: { ...DEFAULT_READING_SETTINGS },
	usageSnapshot: null,
	automaticSync: false,
	workerUrl: '',
	cloudflareDeployment: null,
	lastSync: null,
	lastSeq: 0,
	deviceId: '',
	ignorePatterns: ['.git/', '.trash/', '*.tmp', '.DS_Store', '._*', 'Thumbs.db', 'desktop.ini', '*.swp', '*.swo'],
	syncOnStartup: true,
	syncOnResume: true,
	syncInterval: 300,
	syncHistory: [],
	pushEnabled: false,
	debugLogging: false,
	debounceDelay: 5,
};

export const SECRET_KEYS = {
	AUTH_TOKEN: 'crate-auth-token',
	DEVICE_ID: 'crate-device-id',
	ENCRYPTION_KEYS: 'crate-encryption-keys',
	ENCRYPTION_RESET: 'crate-encryption-reset',
	ENCRYPTION_FOLDER_MOVES: 'crate-encryption-folder-moves',
	ENCRYPTION_RECOVERY: 'crate-encryption-recovery',
} as const;

export type SecretKey = (typeof SECRET_KEYS)[keyof typeof SECRET_KEYS] | `crate-analytics-${string}` | `crate-usage-oauth-${string}`;

export const MAX_SYNC_HISTORY = 20;
export const MAX_SYNC_HISTORY_PATHS = 50;
export const MAX_DEBOUNCE_WAIT_MS = 30_000;
