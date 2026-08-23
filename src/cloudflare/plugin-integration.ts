import { Notice } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
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
	return new CloudflareDeploymentService({
		clientId: CLOUDFLARE_OAUTH_CLIENT_ID,
		settingsOwner: plugin,
		transport: obsidianHttpTransport,
		loadArtifacts: loadEmbeddedCloudflareArtifacts,
		openExternal: url => {
			window.open(url, '_blank', 'noopener,noreferrer');
		},
		selectDeployment: deployments => selectCloudflareServer(plugin.app, deployments),
	});
}

export async function startCloudflareDeployment(plugin: CratePlugin): Promise<void> {
	if (!isCloudflareOAuthConfigured()) {
		new Notice('This build has no Cloudflare deployment client configured');
		return;
	}
	try {
		await plugin.cloudflareDeploymentService.startDeployment();
	} catch (error) {
		new Notice(`Could not start Cloudflare deployment: ${deploymentErrorMessage(error)}`);
	}
}

export async function handleCloudflareOAuthProtocol(
	plugin: CratePlugin,
	params: Record<string, string>,
): Promise<void> {
	plugin.openSettingsTab();
	const shouldConnectDevice = !plugin.syncRuntime.isConfigured();
	const progress = openCloudflareDeploymentModal(
		plugin.app,
		shouldConnectDevice ? 'setup' : 'update',
	);
	const deviceToken = shouldConnectDevice ? generateSecureToken() : null;
	let deployment;
	try {
		deployment = await plugin.cloudflareDeploymentService.handleCallback(
			params,
			deviceToken ? {
				tokenHash: await hashToken(deviceToken),
				deviceId: plugin.settings.deviceId,
				deviceName: getCurrentDeviceName(plugin.settings.deviceId),
				platform: getCurrentPlatformCode(),
			} : undefined,
		);
	} catch (error) {
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
		plugin.refreshSettingsTab();
		progress.fail(
			'Could not connect this device',
			deploymentErrorMessage(error),
			['Select “Connect with Cloudflare” in Crate settings to try again.'],
		);
		return;
	}

	plugin.refreshSettingsTab();
	if (!connection.success) {
		progress.fail(
			'Crate is connected with a warning',
			`The connection test failed: ${connection.error ?? 'Unknown error'}`,
			['Your device credentials were saved. You can retry the connection test from Crate settings.'],
		);
		return;
	}

	progress.setWorking(
		'Syncing your vault',
		'Your server is connected. Running the first sync now.',
	);
	try {
		const syncResult = await plugin.syncRuntime.sync();
		plugin.refreshSettingsTab();
		if (!syncResult.success) {
			progress.fail(
				'Crate is connected with a sync warning',
				`The first sync failed: ${syncResult.errors[0] ?? 'Unknown sync error'}`,
				['Your device is connected. Select “Sync now” to try again.'],
			);
			return;
		}

		progress.succeed(
			'Crate is ready',
			'Your vault is synced and this device is ready to use.',
		);
	} catch (error) {
		plugin.refreshSettingsTab();
		progress.fail(
			'Crate is connected with a sync warning',
			`The first sync failed: ${deploymentErrorMessage(error)}`,
			['Your device is connected. Select “Sync now” to try again.'],
		);
	}
}

function deploymentErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Unknown deployment error';
}
