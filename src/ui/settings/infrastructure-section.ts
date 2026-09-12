import { renderServerResetSetting } from './server-reset-setting';
import { renderInfrastructureManagementSection } from './infrastructure-management-section';
import { renderInfrastructureSyncActions } from './infrastructure-sync-actions';
import type { InfrastructureSectionContext } from './infrastructure-types';
import { createSettingsDisclosure, createSettingsSectionHeading } from './section-helpers';
import { renderTroubleshootingSettings } from './troubleshooting-section';
import { openRemoteRecoveryModal } from '../remote-recovery-modal';
import { Setting } from 'obsidian';

export function renderInfrastructureSection(context: InfrastructureSectionContext): void {
	const { containerEl, plugin } = context;
	createSettingsSectionHeading(containerEl, 'Recovery and troubleshooting');
	if (context.isConfigured) {
		new Setting(containerEl)
			.setName('Restore remote file')
			.setDesc('Restore a server copy of a file replaced or deleted in the last 30 days.')
			.addButton(button => button
				.setButtonText('Browse recoverable files')
				.onClick(() => openRemoteRecoveryModal(plugin.app, plugin.syncRuntime)));

		const recoveryEl = createSettingsDisclosure(containerEl, 'Recovery tools');
		renderInfrastructureSyncActions({ ...context, containerEl: recoveryEl });
	}
	const troubleshootingEl = createSettingsDisclosure(containerEl, 'Troubleshooting');
	renderInfrastructureManagementSection({ ...context, containerEl: troubleshootingEl });
	renderTroubleshootingSettings(troubleshootingEl, plugin);
	if (plugin.settings.cloudflareDeployment?.d1DatabaseId) {
		const advancedEl = createSettingsDisclosure(containerEl, 'Advanced server actions');
		renderServerResetSetting(advancedEl, plugin);
	}
}
export type { InfrastructureSectionContext } from './infrastructure-types';
