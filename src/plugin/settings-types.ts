import type { ServerRestoreState } from '../cloudflare/restore/state';
import type { UsageSnapshot } from '../cloudflare/usage/snapshot';
import type { CloudflareDeploymentMetadata } from '../cloudflare/deployment/types';
import type { PersistedSyncSettings } from '../sync/settings';
import { DEFAULT_READING_SETTINGS, type ReadingSettings } from '../reading/settings';

export interface PersistedCrateSettings extends PersistedSyncSettings {
	cloudflareRestore?: ServerRestoreState | null;
	reading: ReadingSettings;
	usageSnapshot?: UsageSnapshot | null;
	cloudflareDeployment: CloudflareDeploymentMetadata | null;
	debugLogging: boolean;
}

export interface CrateSettings extends PersistedCrateSettings {
	/** Hydrated from local secret storage; never loaded from or saved to plugin data. */
	deviceId: string;
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
	syncInterval: 300,
	syncHistory: [],
	pushEnabled: false,
	debugLogging: false,
	debounceDelay: 5,
};
