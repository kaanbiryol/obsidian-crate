import type CratePlugin from '../plugin/CratePlugin';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';
import { SyncApiClient } from './api';
import { requireNormalizedWorkerUrl } from './worker-url';
import { applySharedSettings } from './shared-settings';
import { SECRET_KEYS } from '../plugin/settings-types';
import { exchangeSelfHostedPairingCode } from './self-hosted-pairing';

const connecting = new WeakSet<CratePlugin>();

export function isSelfHostedConnectionPending(plugin: CratePlugin): boolean {
	return connecting.has(plugin);
}

/** A Quick Tunnel can change address while its persisted server stays the same.
 * Verify the existing credential, then use normal server-change reconciliation
 * because checkpoints and pending journals are scoped to the old URL. */
export async function updateSelfHostedServerAddress(plugin: CratePlugin, address: string): Promise<void> {
	if (plugin.settings.cloudflareDeployment || !plugin.syncRuntime.isConfigured()) throw new Error('Connect to a self-hosted server first.');
	if (connecting.has(plugin) || plugin.cloudflareDeploymentService.isBusy || plugin.cloudflareDeploymentService.pendingIntent) {
		throw new Error('A server connection is already in progress.');
	}
	const expected = { workerUrl: plugin.settings.workerUrl, authToken: plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) || '' };
	if (!expected.authToken) throw new Error('The saved access token is missing.');
	const workerUrl = requireNormalizedWorkerUrl(address);
	const signal = getPluginLifecycleSignal(plugin);
	signal.throwIfAborted();
	connecting.add(plugin);
	try {
		const api = new SyncApiClient(workerUrl, expected.authToken);
		api.setAbortSignal(signal);
		const check = await api.testConnection();
		if (!check.success) throw new Error(check.error || 'Could not connect to this server.');
		await api.listTokens();
		signal.throwIfAborted();
		if (plugin.settings.cloudflareDeployment) throw new Error('The server connection changed. Reopen settings and try again.');
		await plugin.syncRuntime.applyInfrastructureConfig({ workerUrl, authToken: expected.authToken }, signal, expected);
	} finally { connecting.delete(plugin); }
}

/** Validate the server and vault credential before changing local settings. */
export async function connectSelfHostedServer(plugin: CratePlugin, address: string, token: string): Promise<void> {
	const assertAvailable = () => {
		if (plugin.syncRuntime.isConfigured()) throw new Error('Disconnect this device before connecting another server.');
		if (plugin.settings.cloudflareDeployment) throw new Error('Forget the saved Cloudflare connection before connecting your own server.');
		if (plugin.cloudflareDeploymentService.isBusy || plugin.cloudflareDeploymentService.pendingIntent) {
			throw new Error('Finish the Cloudflare connection before connecting your own server.');
		}
	};
	assertAvailable();
	if (connecting.has(plugin)) throw new Error('A server connection is already in progress.');
	const workerUrl = requireNormalizedWorkerUrl(address);
	let authToken = token.trim();
	const pairing = /^crate-pair-[a-f0-9]{64}$/.test(authToken);
	if (!pairing && !/^[a-f0-9]{64}$/.test(authToken)) throw new Error('Paste a pairing code or device access token generated on your Crate server.');
	const signal = getPluginLifecycleSignal(plugin);
	signal.throwIfAborted();
	connecting.add(plugin);
	try {
		if (pairing) authToken = await exchangeSelfHostedPairingCode(workerUrl, authToken, signal);
		const api = new SyncApiClient(workerUrl, authToken);
		api.setAbortSignal(signal);
		const check = await api.testConnection();
		if (!check.success) throw new Error(check.error || 'Could not connect to this server.');
		// Health alone is not proof of vault authority. Reminder-only sessions
		// cannot list devices or read shared settings.
		await api.listTokens();
		const shared = await api.getSharedSettings();
		signal.throwIfAborted();
		assertAvailable();
		plugin.clearSettingsUiState();
		await plugin.syncRuntime.applyInfrastructureConfig({ workerUrl, authToken }, signal);
		signal.throwIfAborted();
		if (shared.settings) {
			applySharedSettings(plugin.settings, shared.settings);
			await plugin.saveSettings();
			plugin.syncRuntime.updateSyncSettings();
		}
	} finally {
		connecting.delete(plugin);
	}
}
