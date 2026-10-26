import type { ConnectionTestResult } from '../sync/types';
import type CratePlugin from './CratePlugin';
import { getPluginLifecycleSignal } from './lifecycle-state';
import { SyncApiClient } from '../sync/worker-api/client';
import { buildSharedSettings } from '../sync/connection/shared-settings';
import type { SharedSettings } from '../protocol/shared-settings';
import { createLogger } from '../sync/logger';
import { errorMessage } from '../platform/logger';
import { writeSyncSettings } from './sync-connection';

const logger = createLogger('CloudflareConnection');

/** Like the self-hosted flow, read the new server's shared settings first but apply
 * them only after the connection is saved. The running engine reads these settings
 * live, so a failed switch must not leave another server's settings on it. This
 * device's settings only seed a server read as having none; a failed or skipped
 * read leaves the server's settings untouched. */
export async function configureCloudflareAuthorizedDevice(
	plugin: CratePlugin,
	workerUrl: string,
	authToken: string,
	expected?: { workerUrl: string; authToken: string },
): Promise<ConnectionTestResult> {
	const signal = getPluginLifecycleSignal(plugin);
	signal.throwIfAborted();
	const api = new SyncApiClient(workerUrl, authToken);
	// Undefined when unknown: the read failed, or was skipped for an encrypted vault.
	let shared: SharedSettings | null | undefined;
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
		// Normalizing adds this device's own workspace exclusion to the server's patterns.
		await writeSyncSettings(plugin, shared);
	} else if (shared === null) {
		await seedSharedSettings(api, plugin.settings);
	}

	return await plugin.syncRuntime.testConnection();
}

/** Create-only, so a device that seeded the fresh deployment first keeps its settings. */
async function seedSharedSettings(api: SyncApiClient, settings: CratePlugin['settings']): Promise<void> {
	try {
		await api.createSharedSettings(buildSharedSettings(settings));
	} catch (error) {
		logger.warn('Did not seed shared settings:', errorMessage(error));
	}
}
