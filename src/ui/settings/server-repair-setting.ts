import { Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { startCloudflareDeployment } from '../../cloudflare/plugin-integration';

export function renderServerRepairSetting(containerEl: HTMLElement, plugin: CratePlugin): void {
	const saved = plugin.settings.cloudflareDeployment;
	if (saved?.deletion) return;
	if (saved?.reset && !saved.reset.deleteOnly) {
		new Setting(containerEl).setName('Interrupted server cleanup')
			.setDesc('Resume this unfinished rebuild using the version that started it, or delete this server for a fresh start. Keep this vault’s saved settings.');
		return;
	}
	if (!saved?.accountId || !saved.d1DatabaseId || saved.reset
		|| saved.lastDeployedVersion || plugin.syncRuntime.isConfigured()) return;
	new Setting(containerEl)
		.setName('Repair server')
		.setDesc('Finish a deployment without deleting remote data. Reconnect this device when setup finishes.')
		.addButton(button => button.setButtonText('Repair server')
			.onClick(() => { void startCloudflareDeployment(plugin, 'update'); }));
}
