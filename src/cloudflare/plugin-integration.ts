import { Notice } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
import { CloudflareDeploymentService } from './deployment-service';
import { loadEmbeddedCloudflareArtifacts } from './embedded-artifacts';
import { obsidianHttpTransport } from './http';
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
		new Notice('This build has no deployment client configured; use the fallback button');
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
	try {
		const result = await plugin.cloudflareDeploymentService.handleCallback(params);
		new Notice(`Cloudflare deployment completed in ${result.accountName}`);
	} catch (error) {
		new Notice(`Cloudflare deployment failed: ${deploymentErrorMessage(error)}`, 15000);
	}
}

function deploymentErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : 'Unknown deployment error';
}
