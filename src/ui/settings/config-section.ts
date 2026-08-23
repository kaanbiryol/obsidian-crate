import { Notice, Setting } from 'obsidian';
import { startCloudflareDeployment } from '../../cloudflare/plugin-integration';
import { openConfirmationModal } from '../confirmation-modal';
import type { ConfigSectionContext } from './config-types';
import { createSettingsSectionHeading } from './section-helpers';

export function renderConfigSection(context: ConfigSectionContext): void {
	const { containerEl, plugin, rerender } = context;
	const isConfigured = plugin.syncRuntime.isConfigured();

	createSettingsSectionHeading(containerEl, 'Configuration');

	if (!isConfigured) {
		new Setting(containerEl)
			.setName('Connect with Cloudflare')
			.setDesc('Sign in to reuse an existing Crate server or create a new private sync server')
			.addButton(button => button
				.setButtonText('Connect with Cloudflare')
				.setCta()
				.onClick(() => {
					void startCloudflareDeployment(plugin);
				}));
	}

	if (isConfigured && plugin.settings.cloudflareDeployment) {
		new Setting(containerEl)
			.setName('Update Cloudflare server')
			.setDesc('Reauthorize briefly and update the existing Worker, D1, R2, and Durable Objects')
			.addButton(button => button
				.setButtonText('Authorize update')
				.onClick(() => {
					void startCloudflareDeployment(plugin);
				}));
	}

	if (isConfigured) {
		new Setting(containerEl)
			.setName('Disconnect this device')
			.setDesc('Clears this device credential but remembers which Cloudflare server belongs to this vault')
			.addButton(button => button
				.setButtonText('Disconnect device')
				.setWarning()
				.onClick(async () => {
					const confirmed = await openConfirmationModal(plugin.app, {
						title: 'Disconnect this device',
						message: 'Disconnect this device from its Crate server?',
						details: ['Cloudflare resources and synced data will not be deleted.'],
						confirmText: 'Disconnect device',
						warning: true,
					});
					if (!confirmed) {
						return;
					}
					plugin.clearSettingsUiState();
					await plugin.syncRuntime.clearSyncConfiguration();
					new Notice('This device was disconnected');
					rerender();
				}));
	}
}
export type { ConfigSectionContext } from './config-types';
