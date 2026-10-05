import { ConnectionSetupError } from './connection-errors';
import type CratePlugin from '../plugin/CratePlugin';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';
import { SyncApiClient } from './api';
import { requireNormalizedWorkerUrl } from './worker-url';
import { applySharedSettings } from './shared-settings';
import { SECRET_KEYS } from '../plugin/settings-types';
import { exchangeSelfHostedPairingCode } from './self-hosted-pairing';
import { loadEncryptionKeys } from '../plugin/encryption-storage';

const connecting = new WeakSet<CratePlugin>();

export function isSelfHostedConnectionPending(plugin: CratePlugin): boolean {
	return connecting.has(plugin);
}

/** A Quick Tunnel can change address while its persisted server stays the same.
 * Authenticate the encrypted vault before retaining its pending disk work.
 * Unencrypted connections keep normal server-change reconciliation. */
export async function updateSelfHostedServerAddress(plugin: CratePlugin, address: string): Promise<void> {
	if (plugin.settings.cloudflareDeployment || !plugin.syncRuntime.isConfigured()) throw new ConnectionSetupError('not-self-hosted');
	if (connecting.has(plugin) || plugin.cloudflareDeploymentService.isBusy || plugin.cloudflareDeploymentService.pendingIntent) {
		throw new ConnectionSetupError('busy');
	}
	const expected = { workerUrl: plugin.settings.workerUrl, authToken: plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) || '' };
	if (!expected.authToken) throw new ConnectionSetupError('missing-token');
	const workerUrl = requireNormalizedWorkerUrl(address);
	const signal = getPluginLifecycleSignal(plugin);
	signal.throwIfAborted();
	connecting.add(plugin);
	try {
		if (plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_RESET)) {
			await plugin.syncRuntime.updateEncryptionResetAddress(workerUrl, signal);
			return;
		}
		const api = new SyncApiClient(workerUrl, expected.authToken);
		api.setAbortSignal(signal);
		const check = await api.testConnection();
		if (!check.success) throw new Error(check.error || 'Could not connect to this server.');
		await api.listTokens();
		const keys = loadEncryptionKeys(plugin.secretStorage);
		if (keys) {
			await plugin.syncRuntime.updateEncryptedServerAddress(workerUrl, signal, expected);
			return;
		}
		signal.throwIfAborted();
		if (plugin.settings.cloudflareDeployment) throw new ConnectionSetupError('changed');
		await plugin.syncRuntime.applyInfrastructureConfig({ workerUrl, authToken: expected.authToken }, signal, expected);
	} finally { connecting.delete(plugin); }
}

/** Validate the server and vault credential before changing local settings. */
export async function connectSelfHostedServer(plugin: CratePlugin, address: string, token: string, reconnect = false): Promise<void> {
	const expected = { workerUrl: plugin.settings.workerUrl, authToken: plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) || '' };
	const assertAvailable = () => {
		if (reconnect && (plugin.settings.workerUrl !== expected.workerUrl || (plugin.secretStorage.get(SECRET_KEYS.AUTH_TOKEN) || '') !== expected.authToken)) throw new ConnectionSetupError('changed');
		if (!reconnect && plugin.syncRuntime.isConfigured()) throw new ConnectionSetupError('already-connected');
		if (plugin.settings.cloudflareDeployment) throw new ConnectionSetupError('cloudflare-saved');
		if (plugin.cloudflareDeploymentService.isBusy || plugin.cloudflareDeploymentService.pendingIntent) {
			throw new ConnectionSetupError('cloudflare-pending');
		}
	};
	assertAvailable();
	if (connecting.has(plugin)) throw new ConnectionSetupError('busy');
	const workerUrl = requireNormalizedWorkerUrl(address);
	if (reconnect && workerUrl !== requireNormalizedWorkerUrl(expected.workerUrl)) throw new ConnectionSetupError('address-update-required');
	let authToken = token.trim();
	const pairing = /^crate-pair-[a-f0-9]{64}$/.test(authToken);
	if (!pairing && !/^[a-f0-9]{64}$/.test(authToken)) throw new ConnectionSetupError('invalid-token');
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
		const encryption = await api.getEncryptionState();
		const shared = encryption ? { settings: null } : await api.getSharedSettings();
		signal.throwIfAborted();
		assertAvailable();
		plugin.clearSettingsUiState();
		await plugin.syncRuntime.applyInfrastructureConfig({ workerUrl, authToken }, signal, ...(reconnect ? [expected] : []));
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
