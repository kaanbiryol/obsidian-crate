import { Notice, Setting } from 'obsidian';
import { CRATE_CLOUDFLARE_DEPLOY_URL } from '../../cloudflare/deploy-button';
import { startCloudflareDeployment } from '../../cloudflare/plugin-integration';
import { normalizeWorkerUrl } from '../../sync/worker-url';
import { openConfirmationModal } from '../confirmation-modal';
import { QRModal } from '../qr-modal';
import { buildSetupLink } from './config-link';
import type { ConfigSectionContext } from './config-types';
import { createSettingsSectionHeading } from './section-helpers';

export function renderConfigSection(context: ConfigSectionContext): void {
	const { containerEl, plugin, rerender } = context;
	const isConfigured = plugin.syncRuntime.isConfigured();

	createSettingsSectionHeading(containerEl, 'Configuration');

	if (!isConfigured) {
		new Setting(containerEl)
			.setName('Deploy sync server')
			.setDesc('Authorize Crate to create a private sync server in your Cloudflare account')
			.addButton(button => button
				.setButtonText('Deploy to Cloudflare')
				.setCta()
				.onClick(() => {
					void startCloudflareDeployment(plugin);
				}));

		new Setting(containerEl)
			.setName('GitHub deploy fallback')
			.setDesc('Use the original repository-based deployment while the new authorization flow is verified')
			.addButton(button => button
				.setButtonText('Open fallback')
				.onClick(() => {
					window.open(CRATE_CLOUDFLARE_DEPLOY_URL, '_blank', 'noopener,noreferrer');
				}));

		let workerUrl = '';
		new Setting(containerEl)
			.setName('Open existing server')
			.setDesc('If deployment did not open the setup page, paste its workers.dev URL here')
			.addText(text => text
				.setPlaceholder('https://crate-sync.example.workers.dev')
				.onChange(value => {
					workerUrl = value;
				}))
			.addButton(button => button
				.setButtonText('Open setup')
				.onClick(() => {
					const normalizedUrl = normalizeWorkerUrl(workerUrl);
					if (!normalizedUrl) {
						new Notice('Enter a valid HTTPS worker URL');
						return;
					}
					window.open(`${normalizedUrl}/`, '_blank', 'noopener,noreferrer');
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
			.setName('Set up another device')
			.setDesc('Create a one-use setup link that expires after 10 minutes. Share it only with the device you are adding.')
			.addButton(button => button
				.setButtonText('Copy link')
				.onClick(async () => {
					const link = await buildSetupLink(plugin);
					if (!link) return;
					await navigator.clipboard.writeText(link);
					new Notice('Setup link copied to clipboard');
					}))
				.addButton(button => button
					.setButtonText('Show code')
					.onClick(async () => {
						const link = await buildSetupLink(plugin);
						if (!link) return;
						new QRModal(plugin.app, link).open();
					}));
	}

	if (isConfigured) {
		new Setting(containerEl)
			.setName('Reset local configuration')
			.setDesc('Clears worker URL/auth token and local infrastructure metadata')
			.addButton(button => button
				.setButtonText('Reset local data')
				.setWarning()
				.onClick(async () => {
					const confirmed = await openConfirmationModal(plugin.app, {
						title: 'Reset local configuration',
						message: 'Clear this device\'s Crate configuration?',
						details: ['Remote Cloudflare resources will not be deleted.'],
						confirmText: 'Reset local data',
						warning: true,
					});
					if (!confirmed) {
						return;
					}
					plugin.clearSettingsUiState();
					await plugin.syncRuntime.clearSyncConfiguration();
					new Notice('Local plugin configuration cleared');
					rerender();
				}));
	}
}
export type { ConfigSectionContext } from './config-types';
export { buildSetupLink } from './config-link';
