import { Notice } from 'obsidian';
import type CratePlugin from './CratePlugin';
import { getPluginLifecycleSignal } from './lifecycle-state';
import { configureCloudflareAuthorizedDevice } from './cloudflare/connection';
import { offerFeatureChoice } from './feature-settings';
import { startVaultReplacement } from './sync-integration';
import { getCurrentDeviceName, getCurrentPlatformCode } from './device-identity';
import { generateSecureToken, hashToken } from './device-token';
import { normalizeCloudflareDeployment } from '../cloudflare/deployment/state';
import { workersDevOrigin } from '../cloudflare/deployment/worker-origin';
import { HttpError, WorkerApiHttpClient } from '../sync/worker-api/http';
import { readServerEncryption } from '../sync/encryption/server-encryption';
import { DEVICE_PAIRING_PATH, parseDevicePairingLink, parseDevicePairingTarget, type DevicePairingTarget } from '../protocol/device-pairing';
import { connectSelfHostedServer } from './self-hosted-connection';
import { selfHostedConnectionMessage } from '../ui/settings/infrastructure/self-hosted-errors';
import { openConfirmationModal } from '../ui/plugin/confirmation-modal';
import { DeviceKeyPairingModal } from '../ui/settings/device-key-pairing-modal';
import { errorMessage } from '../platform/logger';
import { ConnectionSetupError } from '../sync/connection/connection-errors';
import { beginConnectionOperation, runningConnectionOperation } from './connection-operation';

/** Joins this vault to the server that issued the code, as a Cloudflare device without a Cloudflare login. */
export async function redeemDevicePairing(plugin: CratePlugin, target: { origin: string; code: string }): Promise<{ encrypted: boolean; synced: boolean }> {
	const signal = getPluginLifecycleSignal(plugin);
	if (plugin.syncRuntime.isConfigured()) throw new Error('This vault is already connected. Disconnect it in Crate settings first.');
	const http = new WorkerApiHttpClient(target.origin, '');
	http.setAbortSignal(signal);
	const token = generateSecureToken();
	const body = JSON.stringify({ code: target.code, tokenHash: await hashToken(token), deviceId: plugin.settings.deviceId,
		deviceName: getCurrentDeviceName(plugin.settings.deviceId), platform: getCurrentPlatformCode() });
	const exchange = () => http.requestJson<{ tokenId: string; deployment: unknown }>(DEVICE_PAIRING_PATH, { method: 'POST', body });
	let result;
	// The same token hash makes a retry after a lost response safe.
	try { result = await exchange(); }
	catch (error) { if (error instanceof HttpError) throw error; signal.throwIfAborted(); result = await exchange(); }
	signal.throwIfAborted();
	const deployment = normalizeCloudflareDeployment(result.deployment);
	if (!deployment?.workersSubdomain || workersDevOrigin(deployment.workerName, deployment.workersSubdomain) !== target.origin) throw new Error('The server returned an unexpected identity.');
	if (plugin.syncRuntime.isConfigured()) throw new Error('This vault was connected while pairing. Disconnect it before pairing again.');
	const previousDeployment = plugin.settings.cloudflareDeployment;
	await plugin.writeSettings({ cloudflareDeployment: deployment });
	let connection;
	try {
		connection = await configureCloudflareAuthorizedDevice(plugin, target.origin, token);
	} catch (error) {
		// Without a connection, a kept deployment would offer a Reconnect this device has no login for.
		if (!plugin.syncRuntime.isConfigured()) await plugin.writeSettings({ cloudflareDeployment: previousDeployment });
		throw error;
	}
	signal.throwIfAborted();
	const keyed = new WorkerApiHttpClient(target.origin, token);
	keyed.setAbortSignal(signal);
	return { encrypted: (await readServerEncryption(keyed))?.mode === 'active', synced: connection.success };
}

const confirming = new WeakSet<CratePlugin>();

/** A self-hosted code connects through the same checks as the Connect form; it claims the connection itself. */
async function startSelfHostedPairing(plugin: CratePlugin, target: DevicePairingTarget): Promise<void> {
	if (confirming.has(plugin)) return;
	confirming.add(plugin);
	let confirmed;
	try {
		confirmed = await openConfirmationModal(plugin.app, {
			title: 'Connect this vault',
			message: `Connect this vault to ${new URL(target.origin).hostname}?`,
			details: ['This vault will sync with your Crate server.'],
			confirmText: 'Connect',
		});
	} finally { confirming.delete(plugin); }
	if (!confirmed) return;
	new Notice('Connecting to your Crate server…');
	try {
		const { encrypted } = await connectSelfHostedServer(plugin, target.origin, target.code);
		plugin.refreshSettingsTab();
		if (encrypted) { new DeviceKeyPairingModal(plugin).open(); return; }
		void offerFeatureChoice(plugin).finally(() => {
			if (!startVaultReplacement(plugin)) new Notice('Connected. Open the command palette and select Crate: Sync now.');
		});
	} catch (error) {
		if (!getPluginLifecycleSignal(plugin).aborted) new Notice(`Could not connect: ${selfHostedConnectionMessage(error, target.origin)}`);
	}
}

export async function startDevicePairing(plugin: CratePlugin, target: DevicePairingTarget | null): Promise<void> {
	if (!target) { new Notice('This pairing link is invalid. Create a new one in Crate settings on your desktop.'); return; }
	if (target.kind === 'self-hosted') { await startSelfHostedPairing(plugin, target); return; }
	const release = beginConnectionOperation(plugin, 'pairing');
	if (!release) {
		// A repeated link for the pairing already open needs no answer.
		if (runningConnectionOperation(plugin) !== 'pairing') new Notice('Wait for the connection to your server to finish, then open the link again.');
		return;
	}
	try {
		if (!await openConfirmationModal(plugin.app, {
			title: 'Connect this vault',
			message: `Connect this vault to ${new URL(target.origin).hostname}?`,
			details: ['This vault will sync with that Crate server.'],
			confirmText: 'Connect',
		})) return;
		new Notice('Connecting to your Crate server…');
		const result = await redeemDevicePairing(plugin, target);
		plugin.refreshSettingsTab();
		if (result.encrypted) { new DeviceKeyPairingModal(plugin).open(); return; }
		if (!result.synced) { new Notice('Connected, but the connection test failed. To try again, sync from Crate settings.'); return; }
		// Choose features first, so the replacement syncs the chosen folders.
		void offerFeatureChoice(plugin).finally(() => {
			if (!startVaultReplacement(plugin)) new Notice('Connected. Open the command palette and select Crate: Sync now.');
		});
	} catch (error) {
		if (error instanceof ConnectionSetupError && error.code === 'replace-cancelled') new Notice(`${error.message} To connect, create a new code with Add a device on your other device.`);
		else if (!getPluginLifecycleSignal(plugin).aborted) new Notice(`Could not connect: ${errorMessage(error)}`);
	} finally { release(); }
}

export function handleDevicePairingProtocol(plugin: CratePlugin, params: Record<string, string>): Promise<void> {
	return startDevicePairing(plugin, parseDevicePairingTarget(params.server, params.code));
}

export function handleDevicePairingLink(plugin: CratePlugin, link: string): Promise<void> {
	return startDevicePairing(plugin, parseDevicePairingLink(link));
}
