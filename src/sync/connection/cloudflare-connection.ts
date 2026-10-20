import type { ConnectionTestResult } from '../types';
import type CratePlugin from '../../plugin/CratePlugin';
import { getPluginLifecycleSignal } from '../../plugin/lifecycle-state';
import { SyncApiClient } from '../api';
import { applySharedSettings } from './shared-settings';
import type { SharedSettings } from '../../protocol/shared-settings';

/** Like the self-hosted flow, read the new server's shared settings first but apply
 * them only after the connection is saved. The running engine reads these settings
 * live, so a failed switch must not leave another server's settings on it. */
export async function configureCloudflareAuthorizedDevice(
	plugin: CratePlugin,
	workerUrl: string,
	authToken: string,
	expected?: { workerUrl: string; authToken: string },
): Promise<ConnectionTestResult> {
	const signal = getPluginLifecycleSignal(plugin);
	signal.throwIfAborted();
	const api = new SyncApiClient(workerUrl, authToken);
	let shared: SharedSettings | null = null;
	try {
		// An encrypted vault's settings need keys this device may not have yet.
		if (!await api.getEncryptionState()) shared = (await api.getSharedSettings()).settings;
	} catch {
		// Shared settings are optional during first connection.
	}
	signal.throwIfAborted();

	await plugin.syncRuntime.applyInfrastructureConfig({
		workerUrl,
		authToken,
	}, signal, ...(expected ? [expected] : []));
	signal.throwIfAborted();
	if (shared) {
		applySharedSettings(plugin.settings, shared);
		await plugin.saveSettings();
		plugin.syncRuntime.updateSyncSettings();
	}

	void plugin.syncRuntime.pushSharedSettingsBestEffort();
	return await plugin.syncRuntime.testConnection();
}
