import { Setting } from 'obsidian';
import type CratePlugin from '../../main';
import { startCloudflareDeployment } from '../../cloudflare/plugin-integration';

export function renderServerRepairSetting(containerEl: HTMLElement, plugin: CratePlugin): void {
	const saved = plugin.settings.cloudflareDeployment;
	if (saved?.reset && !saved.reset.deleteOnly) {
		new Setting(containerEl).setName('Interrupted server cleanup')
			.setDesc('An unfinished rebuild from an earlier Crate version needs recovery. Complete it using that version before changing this connection. Keep this vault’s saved settings.');
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
