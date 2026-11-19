import { Platform } from 'obsidian';
import type CratePlugin from '../CratePlugin';
import { getPluginLifecycleSignal } from '../lifecycle-state';
import { clearServerConnection } from '../sync-connection';
import { CloudflareSavedLogin } from '../../cloudflare/oauth/saved-login';
import { CloudflareDeploymentService } from '../../cloudflare/deployment/service';
import { loadEmbeddedCloudflareArtifacts } from '../../cloudflare/deployment/embedded-artifacts';
import { cloudflareHttpTransport } from '../../cloudflare/http';
import { CLOUDFLARE_OAUTH_CLIENT_ID } from '../../cloudflare/oauth/config';
import { openCloudflareAuthorizationModal } from '../../ui/cloudflare/authorization-modal';

/** The plugin's Cloudflare login and deployment services, wired to its settings, secrets and lifecycle. */
export function createCloudflareSavedLogin(plugin: CratePlugin): CloudflareSavedLogin {
	return new CloudflareSavedLogin({
		clientId: CLOUDFLARE_OAUTH_CLIENT_ID,
		transport: cloudflareHttpTransport,
		secrets: plugin.secretStorage,
		cache: {
			read: () => plugin.settings.usageSnapshot ?? null,
			write: snapshot => plugin.writeSettings({ usageSnapshot: snapshot }),
		},
		accountId: () => plugin.settings.cloudflareDeployment?.accountId,
		signal: getPluginLifecycleSignal(plugin),
	});
}

export function createCloudflareDeploymentService(plugin: CratePlugin): CloudflareDeploymentService {
	const signal = getPluginLifecycleSignal(plugin);
	return new CloudflareDeploymentService({
		clientId: CLOUDFLARE_OAUTH_CLIENT_ID,
		getVaultName: () => plugin.app.vault.getName(),
		settingsOwner: plugin,
		onAuthorized: (accountId, tokens) => plugin.cloudflareSavedLogin.acceptAuthorization(accountId, tokens),
		withAuthorization: operation => plugin.cloudflareSavedLogin.withAuthorization(operation),
		transport: cloudflareHttpTransport,
		loadArtifacts: loadEmbeddedCloudflareArtifacts,
		openExternal: url => openCloudflareAuthorization(plugin, url),
		serverChangesAllowed: !Platform.isMobile,
		beforeServerSwitch: async () => {
			await clearServerConnection(plugin, signal);
			plugin.refreshSettingsTab();
		},
		beforeServerReset: async () => {
			signal.throwIfAborted();
			await clearServerConnection(plugin, signal);
			signal.throwIfAborted();
			plugin.refreshSettingsTab();
		},
	});
}

function openCloudflareAuthorization(plugin: CratePlugin, url: string): void {
	if (Platform.isMobile) {
		openCloudflareAuthorizationModal(plugin.app, url, getPluginLifecycleSignal(plugin));
		return;
	}
	window.open(url, '_blank', 'noopener,noreferrer');
}
