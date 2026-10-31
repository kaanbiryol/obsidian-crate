import { Setting } from 'obsidian';
import type CratePlugin from '../../../plugin/CratePlugin';
import { startCloudflareDeployment } from '../../../plugin/cloudflare-operations';
import { addServerChangeButton } from './server-change-button';

export function renderServerRepairSetting(containerEl: HTMLElement, plugin: CratePlugin): void {
	const saved = plugin.settings.cloudflareDeployment;
	if (saved?.deletion) return;
	if (!saved?.accountId || !saved.d1DatabaseId
		|| saved.lastDeployedVersion || plugin.syncRuntime.isConfigured()) return;
	addServerChangeButton(new Setting(containerEl)
		.setName('Repair server')
		.setDesc('Finish a deployment without deleting remote data. Reconnect this device when setup finishes.'),
	button => button.setButtonText('Repair server')
		.onClick(() => { void startCloudflareDeployment(plugin, 'update'); }));
}
