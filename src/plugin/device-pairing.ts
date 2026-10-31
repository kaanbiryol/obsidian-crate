import { Notice } from 'obsidian';
import type CratePlugin from './CratePlugin';
import { getPluginLifecycleSignal } from './lifecycle-state';
import { configureCloudflareAuthorizedDevice } from './cloudflare-connection';
import { offerFeatureChoice } from './feature-settings';
import { getCurrentDeviceName, getCurrentPlatformCode } from './deviceInfo';
import { generateSecureToken, hashToken } from '../cloudflare/device-token';
import { normalizeCloudflareDeployment } from '../cloudflare/deployment/state';
import { workersDevOrigin } from '../cloudflare/deployment/worker-origin';
import { HttpError, WorkerApiHttpClient } from '../sync/worker-api/http';
import { readServerEncryption } from '../sync/encryption/server-encryption';
import { DEVICE_PAIRING_CAPABILITY, DEVICE_PAIRING_PATH, parseDevicePairingLink, parseDevicePairingTarget } from '../protocol/device-pairing';
import { openConfirmationModal } from '../ui/confirmation-modal';
import { DeviceKeyPairingModal } from '../ui/settings/device-key-pairing-modal';
import { errorMessage } from '../platform/logger';

const pairing = new WeakSet<CratePlugin>();

/** Joins this vault to the server that issued the code, as a Cloudflare device without a Cloudflare login. */
export async function redeemDevicePairing(plugin: CratePlugin, target: { origin: string; code: string }): Promise<{ encrypted: boolean; synced: boolean }> {
	const signal = getPluginLifecycleSignal(plugin);
	if (plugin.syncRuntime.isConfigured()) throw new Error('This vault is already connected. Disconnect it in Crate settings first.');
	const http = new WorkerApiHttpClient(target.origin, '');
	http.setAbortSignal(signal);
	if (!(await http.getServerInfo()).capabilities.includes(DEVICE_PAIRING_CAPABILITY)) throw new Error('Update the server from Crate settings on your desktop, then create a new code.');
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
	await plugin.writeSettings({ cloudflareDeployment: deployment });
	const connection = await configureCloudflareAuthorizedDevice(plugin, target.origin, token);
	signal.throwIfAborted();
	const keyed = new WorkerApiHttpClient(target.origin, token);
	keyed.setAbortSignal(signal);
	return { encrypted: (await readServerEncryption(keyed))?.mode === 'active', synced: connection.success };
}

export async function startDevicePairing(plugin: CratePlugin, target: { origin: string; code: string } | null): Promise<void> {
	if (!target) { new Notice('This pairing link is invalid. Create a new one in Crate settings on your desktop.'); return; }
	if (pairing.has(plugin)) return;
	pairing.add(plugin);
	try {
		if (!await openConfirmationModal(plugin.app, {
			title: 'Connect this vault',
			message: `Connect this vault to ${new URL(target.origin).hostname}?`,
			details: ['This vault will sync with that Crate server. Use an empty vault for a fresh copy; notes already here are combined with the synced ones.'],
			confirmText: 'Connect',
		})) return;
		new Notice('Connecting to your Crate server…');
		const result = await redeemDevicePairing(plugin, target);
		plugin.refreshSettingsTab();
		if (result.encrypted) { new DeviceKeyPairingModal(plugin).open(); return; }
		new Notice(result.synced ? 'Connected. Open the command palette and select Crate: Sync now.' : 'Connected, but the connection test failed. Check Crate settings.');
		if (result.synced) void offerFeatureChoice(plugin);
	} catch (error) {
		if (!getPluginLifecycleSignal(plugin).aborted) new Notice(`Could not connect: ${errorMessage(error)}`);
	} finally { pairing.delete(plugin); }
}

export function handleDevicePairingProtocol(plugin: CratePlugin, params: Record<string, string>): Promise<void> {
	return startDevicePairing(plugin, parseDevicePairingTarget(params.server, params.code));
}

export function handleDevicePairingLink(plugin: CratePlugin, link: string): Promise<void> {
	return startDevicePairing(plugin, parseDevicePairingLink(link));
}
