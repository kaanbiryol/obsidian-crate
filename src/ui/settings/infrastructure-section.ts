import { renderServerDeleteSetting } from './server-delete-setting';
import { renderServerRepairSetting } from './server-repair-setting';
import { renderInfrastructureManagementSection } from './infrastructure-management-section';
import { renderInfrastructureSyncActions } from './infrastructure-sync-actions';
import type { InfrastructureSectionContext } from './infrastructure-types';
import { createSettingsDisclosure } from './section-helpers';
import { renderTroubleshootingSettings } from './troubleshooting-section';
import { Setting } from 'obsidian';

export function renderInfrastructureSection(context: InfrastructureSectionContext): void {
	const { containerEl, plugin } = context;
	const recoverySection = createSettingsDisclosure(containerEl, 'Recovery and troubleshooting');
	if (context.isConfigured) {
		const recoveryEl = createSettingsDisclosure(recoverySection, 'File history');
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
	const troubleshootingEl = createSettingsDisclosure(recoverySection, 'Troubleshooting');
	renderInfrastructureManagementSection({ ...context, containerEl: troubleshootingEl });
	renderTroubleshootingSettings(troubleshootingEl, plugin);
	renderServerRepairSetting(troubleshootingEl, plugin);
	if (context.isConfigured || plugin.settings.cloudflareDeployment?.d1DatabaseId) {
		const advancedEl = createSettingsDisclosure(containerEl, 'Advanced server actions');
		if (context.isConfigured) renderInfrastructureSyncActions({ ...context, containerEl: advancedEl });
		const saved = plugin.settings.cloudflareDeployment;
		if (context.isConfigured || saved?.reset?.deleteOnly) renderServerDeleteSetting(advancedEl, plugin);
		if (!advancedEl.hasChildNodes()) advancedEl.parentElement?.remove();
	}
}
export type { InfrastructureSectionContext } from './infrastructure-types';
