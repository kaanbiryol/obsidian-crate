import { renderVersionSettings, renderUpdateVersions } from './version-settings';
import { checkAndRecoverUpdate } from '../../cloudflare/deployment-recovery-ui';
import { Notice, Setting } from 'obsidian';
import { EMBEDDED_CLOUDFLARE_ARTIFACT } from '../../cloudflare/embedded-artifacts';
import { isCloudflareServerUpdateAvailable } from '../../cloudflare/deployment-update';
import { startCloudflareDeployment } from '../../cloudflare/plugin-integration';
import { openConfirmationModal } from '../confirmation-modal';
import type { ConfigSectionContext } from './config-types';
import { createSettingsSectionHeading, createSettingsDisclosure } from './section-helpers';

export function renderConfigSection(context: ConfigSectionContext, showHeading = true): void {
	const { containerEl, plugin } = context;
	const isConfigured = plugin.syncRuntime.isConfigured();

	if (showHeading) createSettingsSectionHeading(containerEl, 'Account and connection');
	if (isConfigured) renderAccountSection(context);

	const deployment = plugin.settings.cloudflareDeployment;
	if (!isConfigured) {
		const rememberedServer = Boolean(deployment?.accountId && deployment.d1DatabaseId);
		const connectionLabel = rememberedServer ? 'Reconnect' : 'Connect with Cloudflare';
		new Setting(containerEl)
			.setName(connectionLabel)
			.setDesc(rememberedServer
				? 'Reconnect to your previous server using your saved Cloudflare login. Sign in again only if needed.'
				: 'Sign in to connect to an existing Crate server or create one in your Cloudflare account. Cloudflare plan limits and usage charges may apply.')
			.addButton(button => button
				.setButtonText(connectionLabel)
				.setCta()
				.onClick(() => {
					void startCloudflareDeployment(plugin);
				}));
	}
}

export function renderServerUpdateNotice(context: ConfigSectionContext): void {
    const { containerEl, plugin } = context;
    const deployment = plugin.settings.cloudflareDeployment;
    if (!plugin.syncRuntime.isConfigured() || !deployment
        || !isCloudflareServerUpdateAvailable(deployment, EMBEDDED_CLOUDFLARE_ARTIFACT)) return;

    const update = new Setting(containerEl)
        .setName('Cloudflare update available')
        .setDesc('Update your sync server and reminders web app to the version included with this Crate plugin.')
        .addButton(button => button
            .setButtonText('Update server')
            .setCta()
            .onClick(() => { void startCloudflareDeployment(plugin); }));
    renderUpdateVersions(update, plugin);
}

export function renderServerSection(context: ConfigSectionContext): void {
    const { containerEl, plugin } = context;
    const deployment = plugin.settings.cloudflareDeployment;
    renderVersionSettings(containerEl, plugin);
    if (plugin.syncRuntime.isConfigured() && deployment?.accountId && !deployment.vaultName) {
        new Setting(containerEl).setName('Vault name')
            .setDesc('Save this vault’s name so you can recognize its server on other devices. This updates the Cloudflare server.')
            .addButton(button => button.setButtonText('Save vault name')
                .onClick(() => { void startCloudflareDeployment(plugin, 'update'); }));
    }
    if (plugin.syncRuntime.isConfigured() && deployment?.accountId && deployment.d1DatabaseId) {
        new Setting(containerEl).setName('Interrupted server update')
            .setDesc('Check an interrupted update and recover it when Cloudflare has confirmed the operation.')
            .addButton(button => button.setButtonText('Check and recover update')
                .onClick(() => { void checkAndRecoverUpdate(plugin); }));
    }
	const details = createSettingsDisclosure(containerEl, 'Server details');
	new Setting(details).setName('Server address').setDesc(plugin.settings.workerUrl || 'Not connected on this device');
	new Setting(details).setName('Cloudflare dashboard')
		.addButton(button => button.setButtonText('Open Cloudflare').onClick(() => {
			window.open('https://dash.cloudflare.com/', '_blank', 'noopener,noreferrer');
		}));
}

export function renderAccountSection(context: ConfigSectionContext): void {
	const { containerEl, plugin, rerender } = context;
	const isConfigured = plugin.syncRuntime.isConfigured();
	if (isConfigured) {
		const deployment = plugin.settings.cloudflareDeployment;
		const account = deployment?.accountName?.trim() || deployment?.accountId;
		new Setting(containerEl)
			.setName(account || 'Connected to Crate')
			.setDesc(account
				? 'This device is connected. Disconnecting stops sync here but keeps your saved server and Cloudflare login.'
				: plugin.settings.workerUrl || 'This device is connected to your Crate server.')
			.addButton(button => button
				.setButtonText('Disconnect this device')
				.setDestructive()
				.onClick(async () => {
					const confirmed = await openConfirmationModal(plugin.app, {
						title: 'Disconnect this device',
						message: 'Disconnect this device from its Crate server?',
						details: ['Sync stops on this device. Your saved server and Cloudflare login are kept for reconnecting. Cloudflare resources and synced data are not deleted.'],
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
