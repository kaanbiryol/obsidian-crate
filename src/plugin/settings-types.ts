import type { CloudflareDeploymentMetadata } from '../cloudflare/deployment-types';
import type { SyncHistoryEntry } from '../sync/types';

export interface CrateSettings {
	workerUrl: string;
	cloudflareDeployment: CloudflareDeploymentMetadata | null;
	lastSync: string | null;
	lastSeq: number;
	deviceId: string;
	ignorePatterns: string[];
	syncOnStartup: boolean;
	syncOnResume: boolean;
	syncInterval: number;
	showStatusBar: boolean;
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
	showStatusBar: boolean;
	pushEnabled: boolean;
}

export const DEFAULT_SETTINGS: CrateSettings = {
	workerUrl: '',
	cloudflareDeployment: null,
	lastSync: null,
	lastSeq: 0,
	deviceId: '',
	ignorePatterns: ['.git/', '.trash/', '*.tmp', '.DS_Store'],
	syncOnStartup: true,
	syncOnResume: true,
	syncInterval: 300,
	showStatusBar: true,
	syncHistory: [],
	pushEnabled: false,
	debugLogging: false,
	debounceDelay: 5,
};

export const SECRET_KEYS = {
	AUTH_TOKEN: 'crate-auth-token',
	DEVICE_ID: 'crate-device-id',
} as const;

export type SecretKey = (typeof SECRET_KEYS)[keyof typeof SECRET_KEYS];

export const MAX_SYNC_HISTORY = 20;
export const MAX_SYNC_HISTORY_PATHS = 50;
export const MAX_DEBOUNCE_WAIT_MS = 30_000;
