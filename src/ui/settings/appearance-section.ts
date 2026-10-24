import { Notice, Setting } from 'obsidian';
import { errorMessage } from '../../platform/logger';
import { normalizeListStyle } from '../shared/list-style';
import { createSettingsSectionHeading, type SettingsSectionContext } from './section-helpers';

export function renderAppearanceSettings({ containerEl, plugin, rerender }: SettingsSectionContext): void {
	createSettingsSectionHeading(containerEl, 'Appearance');
	new Setting(containerEl)
		.setName('List style')
		.setDesc('This device · use flat rows or cards for reminders, projects, and saved links, including reminders in notes.')
		.addDropdown(dropdown => dropdown
			.addOption('flat', 'Flat')
			.addOption('cards', 'Cards')
			.setValue(plugin.remindersSettings.listStyle)
			.onChange(async value => {
				try { await plugin.writeRemindersSettings({ listStyle: normalizeListStyle(value) }); }
				catch (error) {
					new Notice(`Failed to save list style: ${errorMessage(error)}`);
					rerender();
				}
			}));
}
