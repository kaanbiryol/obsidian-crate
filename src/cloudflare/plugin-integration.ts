import { Notice } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
import { CloudflareDeploymentService } from './deployment-service';
import { loadEmbeddedCloudflareArtifacts } from './embedded-artifacts';
import { obsidianHttpTransport } from './http';
import { configureInitialCloudflareDevice } from '../sync/plugin-integration';
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
	new Notice('Cloudflare authorized. Crate is deploying your sync server…', 10000);
	let deployment;
	try {
		deployment = await plugin.cloudflareDeploymentService.handleCallback(params);
	} catch (error) {
		new Notice(`Cloudflare deployment failed: ${deploymentErrorMessage(error)}`, 15000);
		return;
	}

	if (plugin.syncRuntime.isConfigured()) {
		new Notice(`Cloudflare server updated in ${deployment.accountName}`);
		return;
	}

	new Notice('Cloudflare server created. Connecting this device…', 10000);
	try {
		const connection = await configureInitialCloudflareDevice(plugin, deployment.workerUrl);
		if (connection.success) {
			new Notice(`Cloudflare deployment completed in ${deployment.accountName}`);
		} else {
			new Notice(`Crate is connected, but its connection test failed: ${connection.error}`);
		}
	} catch (error) {
		new Notice(
			`Cloudflare server was created, but connecting this device failed: ${deploymentErrorMessage(error)}`,
			15000,
		);
	}
}

function deploymentErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Unknown deployment error';
}
