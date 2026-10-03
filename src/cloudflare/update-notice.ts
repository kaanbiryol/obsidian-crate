import { Notice } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
import { isCloudflareServerUpdateAvailable } from './deployment-update';
import { EMBEDDED_CLOUDFLARE_ARTIFACT } from './embedded-artifacts';
import release from './server-release.json';

export function showCloudflareServerUpdateNotice(plugin: CratePlugin): void {
	const deployment = plugin.settings.cloudflareDeployment;
	if (
		!plugin.syncRuntime.isConfigured()
		|| !deployment
		|| (EMBEDDED_CLOUDFLARE_ARTIFACT.development
			&& EMBEDDED_CLOUDFLARE_ARTIFACT.development.worker !== deployment.workerName)
		|| !isCloudflareServerUpdateAvailable(deployment, EMBEDDED_CLOUDFLARE_ARTIFACT)
	) {
		return;
	}

	const revision = plugin.syncRuntime.getCachedVersionInfo()?.serverRevision
		?? (plugin.settings.workerUrl === `https://${deployment.workerName}.${deployment.workersSubdomain}.workers.dev`
			? deployment.lastKnownRevision : undefined);
	const serverIsNewer = revision !== undefined && revision > release.revision;
	const fragment = new DocumentFragment();
	fragment.createSpan({ text: serverIsNewer
		? 'Your Crate server is newer than this plugin’s bundled server. '
		: 'Review your Crate server update. ' });
	const link = fragment.createEl('a', { text: 'Open settings' });
	link.addEventListener('click', () => {
		plugin.openSettingsTab();
	});
	fragment.createSpan({ text: serverIsNewer
		? ' to review the versions. Updating this server requires a newer plugin build.'
		: ' to update or verify the Worker and web app.' });
	new Notice(fragment, 15000);
}
