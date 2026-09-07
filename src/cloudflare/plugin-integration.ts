import { Notice } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
import { getPluginLifecycleSignal } from '../plugin/lifecycle-state';
import { CloudflareDeploymentService } from './deployment-service';
import { loadEmbeddedCloudflareArtifacts } from './embedded-artifacts';
import { obsidianHttpTransport } from './http';
import { configureCloudflareAuthorizedDevice } from '../sync/plugin-integration';
import { generateSecureToken, hashToken } from '../sync/device-token';
import { getCurrentDeviceName, getCurrentPlatformCode } from '../plugin/deviceInfo';
import { openCloudflareDeploymentModal } from '../ui/cloudflare-deployment-modal';
import { selectCloudflareServer } from '../ui/cloudflare-server-picker-modal';
import {
	CLOUDFLARE_OAUTH_CLIENT_ID,
	isCloudflareOAuthConfigured,
} from './oauth-config';

export function createCloudflareDeploymentService(plugin: CratePlugin): CloudflareDeploymentService {
	const signal = getPluginLifecycleSignal(plugin);
	return new CloudflareDeploymentService({
		clientId: CLOUDFLARE_OAUTH_CLIENT_ID,
		settingsOwner: plugin,
		transport: obsidianHttpTransport,
		loadArtifacts: loadEmbeddedCloudflareArtifacts,
		openExternal: url => {
			window.open(url, '_blank', 'noopener,noreferrer');
		},
		selectDeployment: deployments => selectCloudflareServer(plugin.app, deployments),
		beforeServerReset: async () => {
			signal.throwIfAborted();
			plugin.clearSettingsUiState();
			await plugin.syncRuntime.clearSyncConfiguration(signal);
			signal.throwIfAborted();
			plugin.refreshSettingsTab();
		},
	});
}

export async function startCloudflareDeployment(plugin: CratePlugin, intent?: 'update' | 'reset' | 'delete'): Promise<void> {
	const signal = getPluginLifecycleSignal(plugin);
	if (signal.aborted) return;
	if (!isCloudflareOAuthConfigured()) {
		new Notice('This build has no Cloudflare deployment client configured');
		return;
	}
	try {
		await plugin.cloudflareDeploymentService.startDeployment(intent ?? (plugin.syncRuntime.isConfigured() ? 'update' : 'connect'));
	} catch (error) {
		if (signal.aborted) return;
		new Notice(`Could not start Cloudflare deployment: ${deploymentErrorMessage(error)}`);
	}
}

export async function handleCloudflareOAuthProtocol(
	plugin: CratePlugin,
	params: Record<string, string>,
): Promise<void> {
	const signal = getPluginLifecycleSignal(plugin);
	if (signal.aborted) return;
	plugin.openSettingsTab();
	const isDelete = plugin.cloudflareDeploymentService.pendingIntent === 'delete';
	const isReset = plugin.cloudflareDeploymentService.pendingIntent === 'reset';
	const shouldConnectDevice = !isDelete && (isReset || !plugin.syncRuntime.isConfigured());
	const progress = openCloudflareDeploymentModal(
		plugin.app,
		shouldConnectDevice ? 'setup' : 'update',
	);
	if (isDelete) progress.setWorking('Deleting Crate server', 'Verifying this server, then removing its remote data and Worker. Keep Obsidian open.');
	if (isReset) progress.setWorking('Resetting Crate server', 'Verifying this deployment, then erasing its remote data and rebuilding. Keep Obsidian open.');
	const deviceToken = shouldConnectDevice ? generateSecureToken() : null;
	let deployment;
	try {
		const device = deviceToken ? {
			tokenHash: await hashToken(deviceToken),
			deviceId: plugin.settings.deviceId,
			deviceName: getCurrentDeviceName(plugin.settings.deviceId),
			platform: getCurrentPlatformCode(),
		} : undefined;
		if (signal.aborted) return;
		deployment = await plugin.cloudflareDeploymentService.handleCallback(
			params,
			device,
			message => {
				if (!signal.aborted) progress.setWorking(isReset ? 'Resetting Crate server' : isDelete ? 'Deleting Crate server' : shouldConnectDevice ? 'Setting up Crate' : 'Updating Crate server', message);
			},
		);
	} catch (error) {
		if (signal.aborted) return;
		if (isDelete) {
			plugin.refreshSettingsTab();
			progress.fail('Server deletion failed', 'Crate couldn’t finish deleting your Cloudflare server.',
				['Open Crate settings → Troubleshooting to review and retry server deletion.'],
				{ technicalDetails: deploymentErrorMessage(error), action: { label: 'Open settings', onClick: () => plugin.openSettingsTab() } });
			return;
		}
		if (isReset) {
			plugin.refreshSettingsTab();
			const resetAction = plugin.settings.cloudflareDeployment?.reset ? 'Resume server reset' : 'Reset server';
			progress.fail(
				'Server reset failed',
				'Crate couldn’t finish resetting your Cloudflare server.',
				[deploymentErrorMessage(error).startsWith('Reset blocked:')
					? 'Review the technical details below. The reported issue must be resolved before resetting this server.'
					: `In Crate settings → Troubleshooting, select “${resetAction}” to try again.`],
				{ technicalDetails: deploymentErrorMessage(error), action: { label: 'Open settings', onClick: () => plugin.openSettingsTab() } },
			);
			return;
		}
		progress.fail(
			shouldConnectDevice
				? 'Could not prepare your Cloudflare server'
				: 'Could not update your Cloudflare server',
			deploymentErrorMessage(error),
			[shouldConnectDevice
				? 'Select “Connect with Cloudflare” in Crate settings to start again.'
				: 'Select “Authorize update” in Crate settings to try again.'],
		);
		return;
	}
	if (signal.aborted) return;

	if (deployment.deleted) {
		plugin.refreshSettingsTab();
		progress.succeed('Crate server deleted', 'This server’s Worker and remote data have been removed. Your local vault files are kept.');
		return;
	}

	if (!shouldConnectDevice) {
		plugin.refreshSettingsTab();
		progress.succeed(
			'Cloudflare server updated',
			'Your Worker and Crate web app are now up to date.',
		);
		return;
	}

	progress.setWorking(
		'Connecting this device',
		'Creating a private credential for this device. Keep Obsidian open.',
	);
	let connection: { success: boolean; error?: string };
	try {
		if (!deviceToken) throw new Error('Device credential was not created');
		connection = await configureCloudflareAuthorizedDevice(
			plugin,
			deployment.workerUrl,
			deviceToken,
		);
	} catch (error) {
		if (signal.aborted) return;
		plugin.refreshSettingsTab();
		progress.fail(
			'Could not connect this device',
			deploymentErrorMessage(error),
			['Select “Connect with Cloudflare” in Crate settings to try again.'],
		);
		return;
	}
	if (signal.aborted) return;

	plugin.refreshSettingsTab();
	if (!connection.success) {
		progress.fail(
			'Crate is connected with a warning',
			`The connection test failed: ${connection.error ?? 'Unknown error'}`,
			['Your device credentials were saved. You can retry the connection test from Crate settings.'],
		);
		return;
	}

	progress.succeed(
		isReset ? 'Crate server reset' : 'Crate is connected',
		isReset ? 'This device is connected. Run Initial sync → Upload all to seed the server. Reconnect other devices and set up web push again.' : 'No vault files were transferred. Use Initial sync to seed a new server, or Sync now to join an existing one.',
	);
}

function deploymentErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Unknown deployment error';
}
