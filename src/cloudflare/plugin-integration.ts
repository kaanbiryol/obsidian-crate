import { DeploymentRecoveryRequiredError } from './deployment-fence';
import { Notice } from 'obsidian';
import { CloudflareReauthorizationRequired } from './oauth-client';
import { CloudflareUsageConnection } from './usage-connection';
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

export function createCloudflareUsageConnection(plugin: CratePlugin): CloudflareUsageConnection {
	return new CloudflareUsageConnection({
		clientId: CLOUDFLARE_OAUTH_CLIENT_ID,
		transport: obsidianHttpTransport,
		secrets: plugin.secretStorage,
		cache: {
			read: () => plugin.settings.usageSnapshot ?? null,
			write: snapshot => plugin.writeSettings({ usageSnapshot: snapshot }),
		},
		accountId: () => plugin.settings.cloudflareDeployment?.accountId,
		signal: getPluginLifecycleSignal(plugin),
		openExternal: url => { window.open(url, '_blank', 'noopener,noreferrer'); },
	});
}

export function createCloudflareDeploymentService(plugin: CratePlugin): CloudflareDeploymentService {
	const signal = getPluginLifecycleSignal(plugin);
	return new CloudflareDeploymentService({
		clientId: CLOUDFLARE_OAUTH_CLIENT_ID,
		settingsOwner: plugin,
		onAuthorized: (accountId, tokens) => plugin.cloudflareUsageConnection.acceptAuthorization(accountId, tokens),
		transport: obsidianHttpTransport,
		loadArtifacts: loadEmbeddedCloudflareArtifacts,
		openExternal: url => {
			window.open(url, '_blank', 'noopener,noreferrer');
		},
		selectDeployment: (deployments, missingServer) => selectCloudflareServer(plugin.app, deployments, missingServer),
		beforeServerSwitch: async () => {
			plugin.clearSettingsUiState();
			await plugin.syncRuntime.clearSyncConfiguration(signal);
			plugin.refreshSettingsTab();
		},
		beforeServerReset: async () => {
			signal.throwIfAborted();
			plugin.clearSettingsUiState();
			await plugin.syncRuntime.clearSyncConfiguration(signal);
			signal.throwIfAborted();
			plugin.refreshSettingsTab();
		},
	});
}

export async function startCloudflareDeployment(plugin: CratePlugin, intent?: 'switch' | 'create' | 'update' | 'reset' | 'delete'): Promise<void> {
	const signal = getPluginLifecycleSignal(plugin);
	if (signal.aborted) return;
	if (!isCloudflareOAuthConfigured()) {
		new Notice('This build has no Cloudflare deployment client configured');
		return;
	}
	try {
		const selectedIntent = intent ?? (plugin.syncRuntime.isConfigured() ? 'update' : 'connect');
		if (['connect', 'update', 'reset', 'delete'].includes(selectedIntent) && plugin.settings.cloudflareDeployment?.accountId) {
			await runCloudflareOperation(plugin, {}, selectedIntent as 'connect' | 'update' | 'reset' | 'delete');
			return;
		}
		await plugin.cloudflareDeploymentService.startDeployment(selectedIntent);
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
	if (params.state?.startsWith('usage-')) {
		try {
			await plugin.cloudflareUsageConnection.handleCallback(params);
			if (!signal.aborted) new Notice('Cloudflare usage connected. Refresh to load usage.');
		} catch (error) {
			if (!signal.aborted) new Notice(deploymentErrorMessage(error));
		}
		if (!signal.aborted) plugin.refreshSettingsTab();
		return;
	}
	await runCloudflareOperation(plugin, params);
}

async function runCloudflareOperation(
	plugin: CratePlugin, params: Record<string, string>, savedIntent?: 'connect' | 'update' | 'reset' | 'delete',
): Promise<void> {
	const signal = getPluginLifecycleSignal(plugin);
	if (signal.aborted) return;
	const intent = savedIntent ?? plugin.cloudflareDeploymentService.pendingIntent;
	const originalDeployment = JSON.stringify(plugin.settings.cloudflareDeployment);
	const isDelete = intent === 'delete';
	const isReset = intent === 'reset';
	const isSwitch = ['switch', 'create'].includes(intent ?? '');
	const shouldConnectDevice = !isDelete && (isSwitch || isReset || !plugin.syncRuntime.isConfigured());
	const progress = openCloudflareDeploymentModal(
		plugin.app,
		shouldConnectDevice ? 'setup' : 'update',
		plugin.getSettingsDocument(),
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
		if (savedIntent && originalDeployment !== JSON.stringify(plugin.settings.cloudflareDeployment)) throw new Error('Server settings changed. Confirm the operation again.');
		const onProgress = (message: string) => {
			if (!signal.aborted) progress.setWorking(isReset ? 'Resetting Crate server' : isDelete ? 'Deleting Crate server' : shouldConnectDevice ? 'Setting up Crate' : 'Updating Crate server', message);
		};
		const selectDeployment = (deployments: Parameters<typeof progress.selectVault>[0], missingServer?: boolean) => progress.selectVault(deployments, missingServer);
		deployment = savedIntent
			? await plugin.cloudflareDeploymentService.deployWithSavedAuthorization(savedIntent,
				operation => plugin.cloudflareUsageConnection.withAuthorization(operation), device, onProgress, selectDeployment)
			: await plugin.cloudflareDeploymentService.handleCallback(params, device, onProgress, selectDeployment);
	} catch (error) {
		if (signal.aborted) return;
		if (savedIntent && error instanceof CloudflareReauthorizationRequired) {
			try {
				await plugin.cloudflareDeploymentService.startDeployment(savedIntent);
				if (!signal.aborted) progress.close();
			} catch (authorizationError) {
				if (!signal.aborted) progress.fail('Could not connect to Cloudflare', deploymentErrorMessage(authorizationError), ['Try again from Crate settings.']);
			}
			return;
		}
        if (error instanceof DeploymentRecoveryRequiredError) {
            plugin.refreshSettingsTab();
            progress.fail(
                'Server operation needs review',
                'Crate couldn’t confirm whether Cloudflare finished the operation. Further server changes are blocked to prevent overlapping updates.',
                [
                    'If another device is updating this server, let it finish.',
                    'If the operation was interrupted, its Cloudflare status must be checked and the update lock recovered before trying again.',
                    'Closing this message does not clear the lock.',
                ],
                { technicalDetails: deploymentErrorMessage(error) },
            );
            return;
        }
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
				: 'Select “Update server” in Crate settings to try again.'],
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
		isReset ? 'This device is connected. Open the command palette and select Crate: Sync now to sync this vault with the server. Reconnect other devices and set up web push again.' : 'Connected. Open the command palette and select Crate: Sync now to sync this vault with the server.',
	);
}

function deploymentErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Unknown deployment error';
}
