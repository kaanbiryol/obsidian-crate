import { renderServerDeleteSetting } from './server-delete-setting';
import { renderServerResetSetting } from './server-reset-setting';
import { renderInfrastructureManagementSection } from './infrastructure-management-section';
import { renderInfrastructureSyncActions } from './infrastructure-sync-actions';
import type { InfrastructureSectionContext } from './infrastructure-types';
import { createSettingsDisclosure } from './section-helpers';
import { renderTroubleshootingSettings } from './troubleshooting-section';
import { openRemoteRecoveryModal } from '../remote-recovery-modal';
import { Setting } from 'obsidian';

export function renderInfrastructureSection(context: InfrastructureSectionContext): void {
	const { containerEl, plugin } = context;
	const recoverySection = createSettingsDisclosure(containerEl, 'Recovery and troubleshooting');
	if (context.isConfigured) {
		const recoveryEl = createSettingsDisclosure(recoverySection, 'File recovery');
		new Setting(recoveryEl)
			.setName('Restore a file')
			.setDesc('Previous versions and deleted files are kept for 30 days.')
			.addButton(button => button
				.setButtonText('Browse files')
				.onClick(() => openRemoteRecoveryModal(plugin.app, plugin.syncRuntime)));


	}
	const troubleshootingEl = createSettingsDisclosure(recoverySection, 'Troubleshooting');
	renderInfrastructureManagementSection({ ...context, containerEl: troubleshootingEl });
	renderTroubleshootingSettings(troubleshootingEl, plugin);
	renderServerResetSetting(troubleshootingEl, plugin);
	if (context.isConfigured || plugin.settings.cloudflareDeployment?.d1DatabaseId) {
		const advancedEl = createSettingsDisclosure(containerEl, 'Advanced server actions');
		if (context.isConfigured) renderInfrastructureSyncActions({ ...context, containerEl: advancedEl });
		const saved = plugin.settings.cloudflareDeployment;
		if (context.isConfigured || saved?.reset?.deleteOnly) renderServerDeleteSetting(advancedEl, plugin);
		if (!advancedEl.hasChildNodes()) advancedEl.parentElement?.remove();
	}
}
export type { InfrastructureSectionContext } from './infrastructure-types';
