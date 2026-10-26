import type { ServerRestoreState } from '../cloudflare/restore/state';
import type { UsageSnapshot } from '../cloudflare/usage/snapshot';
import type { CloudflareDeploymentMetadata } from '../cloudflare/deployment/types';
import { DEFAULT_SYNC_SETTINGS, type PersistedSyncSettings } from '../sync/settings';
import type { SharedSettings } from '../protocol/shared-settings';
import { DEFAULT_READING_SETTINGS, type ReadingSettings } from '../reading/settings';

export interface PersistedCrateSettings extends PersistedSyncSettings {
	cloudflareRestore?: ServerRestoreState | null;
	reading: ReadingSettings;
	usageSnapshot?: UsageSnapshot | null;
	cloudflareDeployment: CloudflareDeploymentMetadata | null;
	debugLogging: boolean;
	/** Shared settings as this device last reconciled them with `workerUrl`'s server, so a
	 * change that failed to save stays this device's edit after a restart. */
	sharedSettingsBase?: { workerUrl: string; settings: SharedSettings };
}

export interface CrateSettings extends PersistedCrateSettings {
	/** Hydrated from local secret storage; never loaded from or saved to plugin data. */
	deviceId: string;
}

export const DEFAULT_SETTINGS: CrateSettings = {
	...DEFAULT_SYNC_SETTINGS,
	reading: { ...DEFAULT_READING_SETTINGS },
	usageSnapshot: null,
	cloudflareDeployment: null,
	deviceId: '',
	debugLogging: false,
};
