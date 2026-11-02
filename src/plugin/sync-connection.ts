import type CratePlugin from './CratePlugin';
import type { PersistedCrateSettings } from './settings-types';
import { SyncApiClient } from '../sync/worker-api/client';

/** Saves settings the sync runtime reads, then applies them to the running engine. */
export async function writeSyncSettings(plugin: CratePlugin, update: Partial<PersistedCrateSettings>): Promise<void> {
	await plugin.writeSettings(update);
	plugin.syncRuntime.updateSyncSettings();
}

/** Checks that the server answers and that `token` holds vault authority: health alone
 * is not proof, and reminder-only sessions cannot list devices. Returns the checked client. */
export async function verifyVaultCredential(url: string, token: string, signal: AbortSignal): Promise<SyncApiClient> {
	const api = new SyncApiClient(url, token);
	api.setAbortSignal(signal);
	const check = await api.testConnection();
	if (!check.success) throw new Error(check.error || 'Could not connect to this server.');
	await api.listTokens();
	return api;
}

/** Clears this device's sync connection and the settings state shown for it. */
export function clearServerConnection(plugin: CratePlugin, signal?: AbortSignal): Promise<void> {
	plugin.clearSettingsUiState();
	return plugin.syncRuntime.clearSyncConfiguration(signal);
}

/** Disconnects this device. Forgetting also cancels a pending Cloudflare deployment
 * and drops the saved server, so nothing reconnects to it. */
export async function disconnectDevice(plugin: CratePlugin, { forget }: { forget: boolean }): Promise<void> {
	if (forget) plugin.cloudflareDeploymentService.cancelPendingDeployment();
	await clearServerConnection(plugin);
	if (forget) await plugin.writeSettings({ cloudflareDeployment: null });
}
