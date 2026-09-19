import { Notice, Setting } from 'obsidian';
import { openConfirmationModal } from '../confirmation-modal';
import type { ConfigSectionContext } from './config-types';

export function renderForgetServerSetting({ containerEl, plugin, rerender }: ConfigSectionContext): void {
	const saved = plugin.settings.cloudflareDeployment;
	if (plugin.syncRuntime.isConfigured() || !saved || saved.reset) return;
	new Setting(containerEl)
		.setName('Forget saved connection')
		.setDesc('Forget this vault’s saved server connection. Your Cloudflare login, local files, and server data are kept.')
		.addButton(button => button.setButtonText('Forget saved connection').onClick(async () => {
			const confirmed = await openConfirmationModal(plugin.app, {
				title: 'Forget saved connection', message: 'Forget this vault’s saved server connection?',
				details: ['Sync stops on this device. Local files and Cloudflare resources are kept. The Cloudflare login stays saved.'],
				confirmText: 'Forget saved connection',
			});
			if (!confirmed) return;
			button.setDisabled(true);
			try {
				plugin.cloudflareDeploymentService.cancelPendingDeployment();
				plugin.clearSettingsUiState();
				await plugin.syncRuntime.clearSyncConfiguration();
				await plugin.writeSettings({ cloudflareDeployment: null });
				rerender();
			} catch {
				new Notice('Could not forget the saved connection. Wait for any Cloudflare operation to finish and try again.');
			} finally {
				button.setDisabled(false);
			}
		}));
}
