import type { ConnectionTestResult } from '../types';
import type CratePlugin from '../../plugin/CratePlugin';
import { getPluginLifecycleSignal } from '../../plugin/lifecycle-state';
import { SyncApiClient } from '../api';
import { applySharedSettings } from './shared-settings';

export async function configureCloudflareAuthorizedDevice(
	plugin: CratePlugin,
	workerUrl: string,
	authToken: string,
	expected?: { workerUrl: string; authToken: string },
): Promise<ConnectionTestResult> {
	const signal = getPluginLifecycleSignal(plugin);
	signal.throwIfAborted();
	const api = new SyncApiClient(workerUrl, authToken);
	try {
		const { settings } = await api.getSharedSettings();
		signal.throwIfAborted();
		if (settings) applySharedSettings(plugin.settings, settings);
	} catch {
		// Shared settings are optional during first connection.
	}
	signal.throwIfAborted();

	await plugin.syncRuntime.applyInfrastructureConfig({
		workerUrl,
		authToken,
	}, signal, ...(expected ? [expected] : []));
	signal.throwIfAborted();

	void plugin.syncRuntime.pushSharedSettingsBestEffort();
	return await plugin.syncRuntime.testConnection();
}
