import { renderInfrastructureManagementSection } from './infrastructure-management-section';
import { renderInfrastructureSyncActions } from './infrastructure-sync-actions';
import type { InfrastructureSectionContext } from './infrastructure-types';
import { createSettingsDisclosure, createSettingsSectionHeading } from './section-helpers';
import { renderTroubleshootingSettings } from './troubleshooting-section';
import { openRemoteRecoveryModal } from '../remote-recovery-modal';
import { Setting } from 'obsidian';

export function renderInfrastructureSection(context: InfrastructureSectionContext): void {
	const { containerEl, plugin } = context;
	createSettingsSectionHeading(containerEl, 'Advanced');
	new Setting(containerEl)
		.setName('Restore remote file')
		.setDesc('Restore a server copy of a file replaced or deleted in the last 30 days.')
		.addButton(button => button
			.setButtonText('View retained files')
			.onClick(() => openRemoteRecoveryModal(plugin.app, plugin.syncRuntime)));

	const troubleshootingEl = createSettingsDisclosure(containerEl, 'Troubleshooting');
	renderTroubleshootingSettings(troubleshootingEl, plugin);
	renderInfrastructureManagementSection({ ...context, containerEl: troubleshootingEl });
	const recoveryEl = createSettingsDisclosure(containerEl, 'Recovery tools');
	renderInfrastructureSyncActions({ ...context, containerEl: recoveryEl });
}
export type { InfrastructureSectionContext } from './infrastructure-types';
