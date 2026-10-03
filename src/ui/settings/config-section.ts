import { SECRET_KEYS } from '../../plugin/settings-types';
import { renderVersionSettings, renderUpdateVersions } from './version-settings';
import { checkAndRecoverUpdate } from '../../cloudflare/deployment-recovery-ui';
import { Notice, Platform, Setting, type ButtonComponent } from 'obsidian';
import { EMBEDDED_CLOUDFLARE_ARTIFACT } from '../../cloudflare/embedded-artifacts';
import { isCloudflareServerUpdateAvailable } from '../../cloudflare/deployment-update';
import { startCloudflareDeployment } from '../../cloudflare/plugin-integration';
import { openConfirmationModal } from '../confirmation-modal';
import type { ConfigSectionContext } from './config-types';
import { createSettingsSectionHeading } from './section-helpers';
import { renderSelfHostedSetting, renderSelfHostedAddressSetting } from './self-hosted-setting';
import { openExternalBrowserModal } from '../external-browser-modal';

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
		renderSelfHostedSetting(context);
        renderServerBackupSetting(context);
	}
}

export function renderServerUpdateNotice(context: ConfigSectionContext): void {
    const { containerEl, plugin } = context;
    const deployment = plugin.settings.cloudflareDeployment;
    if (!plugin.syncRuntime.isConfigured() || !deployment
        || !isCloudflareServerUpdateAvailable(deployment, EMBEDDED_CLOUDFLARE_ARTIFACT)) return;

    let needsVerification = false;
    let canUpdate = false;
    let updateButton: ButtonComponent;
    const update = new Setting(containerEl)
        .setName('Cloudflare update available')
        .setDesc('Update your sync server and reminders web app to the version included with this Crate plugin.')
        .addButton(button => {
            updateButton = button;
            button.setButtonText('Update server').setCta().onClick(() => {
                if (!needsVerification && !canUpdate) return;
                if (needsVerification) void checkAndRecoverUpdate(plugin, () => { void startCloudflareDeployment(plugin, 'update'); });
                else void startCloudflareDeployment(plugin);
            });
        });
    renderUpdateVersions(update, plugin, () => {
        needsVerification = true;
        update.setName('Verify server update')
            .setDesc('The live server matches this plugin, but the saved update has not been confirmed. Check its status and recover any interrupted update.');
        updateButton.setButtonText('Check and recover update').setDisabled(false);
        updateButton.buttonEl.show();
    }, available => {
        canUpdate = available;
        updateButton.setDisabled(!available);
        if (available) updateButton.buttonEl.show();
        else updateButton.buttonEl.hide();
    });
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
                .onClick(() => { void checkAndRecoverUpdate(plugin, () => { void startCloudflareDeployment(plugin, 'update'); }); }));
    }
    renderServerBackupSetting(context);
	const details = containerEl;
	const serverAddress = plugin.settings.workerUrl;
	new Setting(details).setName('Server address').setDesc(serverAddress || 'Not connected on this device')
		.addButton(button => button.setButtonText('Copy').setDisabled(!serverAddress).onClick(async () => {
			if (!serverAddress) return;
			try {
				await navigator.clipboard.writeText(serverAddress);
				new Notice('Server address copied');
			} catch {
				new Notice('Could not copy the server address. Select and copy it manually.');
			}
		}));
	if (!deployment) {
		renderSelfHostedAddressSetting({ ...context, containerEl: details });
		new Setting(details).setName('Self-hosted server')
			.setDesc('Manage updates, backups, and new device tokens on the computer running this server.');
		return;
	}
	new Setting(details).setName('Cloudflare dashboard')
		.addButton(button => button.setButtonText('Open Cloudflare').onClick(() => {
			if (Platform.isMobile) {
				openExternalBrowserModal(plugin.app, 'https://dash.cloudflare.com/', {
					title: 'Open Cloudflare',
					message: 'Select the link below to open your Cloudflare dashboard in your browser.',
					linkText: 'Open Cloudflare',
				});
			} else window.open('https://dash.cloudflare.com/', '_blank', 'noopener,noreferrer');
		}));
}

export function renderAccountSection(context: ConfigSectionContext): void {
	const { containerEl, plugin, rerender } = context;
	const isConfigured = plugin.syncRuntime.isConfigured();
	if (isConfigured) {
		const deployment = plugin.settings.cloudflareDeployment;
		if (deployment) {
			new Setting(containerEl).setName('Connection')
				.setDesc('Restore Cloudflare access and this device’s sync connection. Sign in only if needed.')
				.addButton(button => button.setButtonText('Reconnect').onClick(async () => {
					button.setDisabled(true);
					try { await startCloudflareDeployment(plugin, 'reconnect'); }
					finally { button.setDisabled(false); }
				}));
		} else renderSelfHostedSetting(context, true);
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
					let forgetConnection = false;
					const confirmed = await openConfirmationModal(plugin.app, {
						title: 'Disconnect this device',
						message: 'Sync will stop on this device.',
						details: [deployment
							? 'Your local files, server data, and Cloudflare login are kept. Other devices stay connected.'
							: 'Your access token is revoked when the server is reachable. Local files and server data are kept. Other devices stay connected. Generate a new pairing code on your server to reconnect.',
							...(plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_KEYS) ? ['Encryption keys saved on this device will be removed. Keep your recovery key outside this vault before disconnecting.'] : [])],
						checkbox: deployment && !deployment.reset && !deployment.deletion ? {

							label: 'Forget saved connection',
							description: 'You’ll need to select a server to reconnect.',
							onChange: checked => { forgetConnection = checked; },
						} : undefined,
						confirmText: 'Disconnect',
						warning: true,
					});
					if (!confirmed) {
						return;
					}
					button.setDisabled(true);
					try {
						if (forgetConnection) plugin.cloudflareDeploymentService.cancelPendingDeployment();
						plugin.clearSettingsUiState();
						await plugin.syncRuntime.clearSyncConfiguration();
						if (forgetConnection) await plugin.writeSettings({ cloudflareDeployment: null });
						new Notice('This device was disconnected');
						rerender();
					} catch {
						new Notice('Could not finish disconnecting. Wait for any Cloudflare operation to finish and try again.');
					} finally {
						button.setDisabled(false);
					}
				}));
	}
}
export type { ConfigSectionContext } from './config-types';

function renderServerBackupSetting({ containerEl, plugin }: ConfigSectionContext): void {
    const deployment = plugin.settings.cloudflareDeployment;
    if (deployment?.accountId && deployment.d1DatabaseId && !deployment.reset && !deployment.deletion) {
        const restore = plugin.settings.cloudflareRestore;
        new Setting(containerEl).setName('Server backup recovery')
            .setDesc(restore ? 'Review or resume your saved restore. The original server and backup are retained.' : 'Restore an upgrade backup into a separate server, keeping your current files and connection.')
            .addButton(button => button.setButtonText(restore?.phase === 'complete' ? 'View restored server' : restore ? 'Resume restore' : 'Restore backup…')
                .onClick(() => { void import('../../cloudflare/restore/ui').then(({ openServerRestore }) => openServerRestore(plugin)); }));
    }
}
