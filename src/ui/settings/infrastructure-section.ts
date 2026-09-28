import { renderServerDeleteSetting } from './server-delete-setting';
import { renderServerRepairSetting } from './server-repair-setting';
import { renderInfrastructureManagementSection } from './infrastructure-management-section';
import { renderInfrastructureSyncActions } from './infrastructure-sync-actions';
import type { InfrastructureSectionContext } from './infrastructure-types';
import { createSettingsDisclosure, createSettingsSubsectionHeading } from './section-helpers';
import { renderTroubleshootingSettings } from './troubleshooting-section';
import { Setting } from 'obsidian';

export function renderInfrastructureSection(context: InfrastructureSectionContext): void {
	const { containerEl, plugin } = context;
	const recoverySection = createSettingsDisclosure(containerEl, 'Troubleshooting', {
		summary: 'Diagnostics, debug logs, and recovery tools',
	});
	if (context.isConfigured) {
		const recoveryEl = recoverySection;
		const history = new Setting(recoveryEl)
			.setName('File history')
			.setDesc('Previous versions are kept for 30 days. Open a file’s context menu and select ');
		history.descEl.createEl('strong', { text: 'File history' });
		history.descEl.appendText(', or use ');
		history.descEl.createEl('strong', { text: 'Show file history' });
		history.descEl.appendText(' for the active file. For deleted files, use ');
		history.descEl.createEl('strong', { text: 'Sync activity' });
		history.descEl.appendText(' → ');
		history.descEl.createEl('strong', { text: 'History' });
		history.descEl.appendText(' → ');
		history.descEl.createEl('strong', { text: 'File history' });
		history.descEl.appendText('.');

	}
	const troubleshootingEl = recoverySection;
	renderInfrastructureManagementSection({ ...context, containerEl: troubleshootingEl });
	renderTroubleshootingSettings(troubleshootingEl, plugin);
	renderServerRepairSetting(troubleshootingEl, plugin);
	if (!context.isConfigured) renderServerActions(context);
}

export function renderServerActions(context: InfrastructureSectionContext): void {
	const { containerEl, plugin } = context;
	if (context.isConfigured || plugin.settings.cloudflareDeployment?.d1DatabaseId) {
		createSettingsSubsectionHeading(containerEl, 'Advanced server actions');
		const advancedEl = containerEl.createDiv();
		if (context.isConfigured) renderInfrastructureSyncActions({ ...context, containerEl: advancedEl });
		const saved = plugin.settings.cloudflareDeployment;
		if (context.isConfigured || saved?.reset?.deleteOnly) renderServerDeleteSetting(advancedEl, plugin);
	}
}
export type { InfrastructureSectionContext } from './infrastructure-types';
