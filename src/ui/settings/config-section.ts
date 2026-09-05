import { Notice, Setting } from 'obsidian';
import { EMBEDDED_CLOUDFLARE_ARTIFACT } from '../../cloudflare/embedded-artifacts';
import { isCloudflareServerUpdateAvailable } from '../../cloudflare/deployment-update';
import { startCloudflareDeployment } from '../../cloudflare/plugin-integration';
import { openConfirmationModal } from '../confirmation-modal';
import type { ConfigSectionContext } from './config-types';
import { createSettingsSectionHeading } from './section-helpers';

export function renderConfigSection(context: ConfigSectionContext): void {
	const { containerEl, plugin } = context;
	const isConfigured = plugin.syncRuntime.isConfigured();

	createSettingsSectionHeading(containerEl, 'Connection');

	if (!isConfigured) {
		new Setting(containerEl)
			.setName('Connect with Cloudflare')
			.setDesc('Sign in to connect to an existing Crate server or create one in your Cloudflare account. Cloudflare plan limits and usage charges may apply.')
			.addButton(button => button
				.setButtonText('Connect with Cloudflare')
				.setCta()
				.onClick(() => {
					void startCloudflareDeployment(plugin);
				}));
	}

	const deployment = plugin.settings.cloudflareDeployment;
	if (isConfigured && deployment) {
		const updateAvailable = isCloudflareServerUpdateAvailable(
			deployment,
			EMBEDDED_CLOUDFLARE_ARTIFACT,
		);
		const updateSetting = new Setting(containerEl)
			.setName(updateAvailable ? 'Cloudflare update available' : 'Cloudflare server')
			.setDesc(updateAvailable
				? 'This Crate version includes an update for your sync server and reminders web app.'
				: 'Your sync server and reminders web app are up to date.');

		if (updateAvailable) {
			updateSetting.addButton(button => button
				.setButtonText('Authorize update')
				.setCta()
				.onClick(() => {
					void startCloudflareDeployment(plugin);
				}));
		}
	}
}

export function renderDisconnectSetting(context: ConfigSectionContext): void {
	const { containerEl, plugin, rerender } = context;
	const isConfigured = plugin.syncRuntime.isConfigured();
	if (isConfigured) {
		new Setting(containerEl)
			.setName('Disconnect this device')
			.setDesc('Sign out on this device. Crate remembers your server, and your local files and server data are kept.')
			.addButton(button => button
				.setButtonText('Disconnect device')
				.setDestructive()
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
