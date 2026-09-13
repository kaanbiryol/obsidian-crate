import { Notice, Setting } from 'obsidian';
import { openConfirmationModal } from '../confirmation-modal';
import type { ConfigSectionContext } from './config-types';

export function renderForgetServerSetting({ containerEl, plugin, rerender }: ConfigSectionContext): void {
	const saved = plugin.settings.cloudflareDeployment;
	if (!saved || saved.reset) return;
	new Setting(containerEl)
		.setName('Forget server')
		.setDesc('Stop sync and forget this vault’s server selection. Your Cloudflare login, local files, and server data are kept.')
		.addButton(button => button.setButtonText('Forget server').onClick(async () => {
			const confirmed = await openConfirmationModal(plugin.app, {
				title: 'Forget server', message: 'Forget this vault’s saved server connection?',
				details: ['Sync stops on this device. Local files and Cloudflare resources are kept. The Cloudflare login stays saved. Sign out of Cloudflare first if you also want to remove that login.'],
				confirmText: 'Forget server',
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
				new Notice('Could not forget the server. Wait for any Cloudflare operation to finish and try again.');
			} finally {
				button.setDisabled(false);
			}
		}));
}
