import { Notice, Setting } from 'obsidian';
import { openConfirmationModal } from '../confirmation-modal';
import { QRModal } from '../qr-modal';
import { getErrorMessage, runButtonTask } from './action-helpers';
import { buildSetupLink } from './config-link';
import { getConfigSectionState } from './config-state';
import {
	createInfrastructureFromCredentials,
	renderApiTokenSetup,
	resolveCredentialsForSetup,
	seedWizardState,
} from './config-setup-workflows';
import type { ConfigSectionContext } from './config-types';
import { createSettingsSectionHeading } from './section-helpers';

export function renderConfigSection(context: ConfigSectionContext): void {
	const { containerEl, plugin, wizardState, rerender } = context;
	seedWizardState(plugin, wizardState);

	const hasCloudflareCredentials = plugin.cloudflareSession.hasCredentials();
	const isConfigured = plugin.syncRuntime.isConfigured();
	const sectionState = getConfigSectionState({
		hasCloudflareCredentials,
		isConfigured,
		wizardState,
	});

	createSettingsSectionHeading(containerEl, 'Configuration');

	const setupProgress = containerEl.createEl('p', {
		cls: 'crate-action-progress',
	});
	setupProgress.hide();

	if (sectionState.showCreateToken) {
		renderApiTokenSetup(containerEl, plugin, wizardState, rerender);
	} else if (sectionState.showConnectedAccount) {
		new Setting(containerEl)
			.setName('Connected account')
			.setDesc(plugin.settings.cloudflareAccountId)
			.addButton(button => button
				.setButtonText('Log out')
				.setWarning()
				.onClick(async () => {
					await plugin.syncRuntime.clearSyncConfiguration({ clearCloudflareCredentials: true });
					new Notice('Signed out and configuration cleared');
					rerender();
				}));
	}

	if (sectionState.showQuickSetup) {
		new Setting(containerEl)
			.setName('Set up sync')
			.setDesc('Create Cloudflare sync infrastructure or reconnect to an existing setup')
			.addButton(button => button
				.setButtonText('Set up/reconnect')
				.setCta()
				.onClick(async () => {
					await runButtonTask({
						button,
						idleText: 'Set up/reconnect',
						runningText: 'Working...',
						progressEl: setupProgress,
						progressMessage: 'Starting setup...',
						task: async ({ setProgress }) => {
							const creds = await resolveCredentialsForSetup(plugin, wizardState);
							await createInfrastructureFromCredentials(plugin, creds, setProgress);
						},
						onSuccess: () => {
							new Notice('Infrastructure created and plugin configured');
							rerender();
						},
						onError: (error) => {
							new Notice(`Setup failed: ${getErrorMessage(error)}`);
						},
					});
				}));
	}

	if (sectionState.showDeviceSetup) {
		new Setting(containerEl)
			.setName('Set up another device')
			.setDesc('Share a setup link for another device. The link contains sync credentials, so share it securely.')
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

	if (sectionState.showResetLocalConfiguration) {
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
					await plugin.syncRuntime.clearSyncConfiguration();
					new Notice('Local plugin configuration cleared');
					rerender();
				}));
	}
}
export type { CloudflareCredentials, ConfigSectionContext, SetupWizardState } from './config-types';
export { buildSetupLink } from './config-link';
export {
	createInfrastructureFromCredentials,
	resolveCredentialsForSetup,
	seedWizardState,
} from './config-setup-workflows';
