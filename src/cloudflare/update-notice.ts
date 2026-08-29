import { Notice } from 'obsidian';
import type CratePlugin from '../plugin/CratePlugin';
import { isCloudflareServerUpdateAvailable } from './deployment-update';
import { EMBEDDED_CLOUDFLARE_ARTIFACT } from './embedded-artifacts';

export function showCloudflareServerUpdateNotice(plugin: CratePlugin): void {
	const deployment = plugin.settings.cloudflareDeployment;
	if (
		!plugin.syncRuntime.isConfigured()
		|| !deployment
		|| !isCloudflareServerUpdateAvailable(deployment, EMBEDDED_CLOUDFLARE_ARTIFACT)
	) {
		return;
	}

	const fragment = new DocumentFragment();
	fragment.createSpan({ text: 'A Crate server update is available. ' });
	const link = fragment.createEl('a', { text: 'Open settings' });
	link.addEventListener('click', () => {
		plugin.openSettingsTab();
	});
	fragment.createSpan({ text: ' to update the Worker and web app.' });
	new Notice(fragment, 15000);
}
