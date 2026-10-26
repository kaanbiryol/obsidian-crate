import type CratePlugin from './CratePlugin';
import type { PersistedCrateSettings } from './settings-types';

/** Saves settings the sync runtime reads, then applies them to the running engine. */
export async function writeSyncSettings(plugin: CratePlugin, update: Partial<PersistedCrateSettings>): Promise<void> {
	await plugin.writeSettings(update);
	plugin.syncRuntime.updateSyncSettings();
}

/** Disconnects this device. Forgetting also cancels a pending Cloudflare deployment
 * and drops the saved server, so nothing reconnects to it. */
export async function disconnectDevice(plugin: CratePlugin, { forget }: { forget: boolean }): Promise<void> {
	if (forget) plugin.cloudflareDeploymentService.cancelPendingDeployment();
	plugin.clearSettingsUiState();
	await plugin.syncRuntime.clearSyncConfiguration();
	if (forget) await plugin.writeSettings({ cloudflareDeployment: null });
}
