import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import {
	normalizeRemindersFolderPath,
	type AutoOpenSetting,
	type DueDateDefaultSetting,
} from '../../reminders/settings';
import type { TabId } from '../../reminders/ui/layoutConstants';
import { createSettingsSectionHeading } from './section-helpers';

export interface RemindersSectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
	rerender: () => void;
}

export function renderRemindersSection(context: RemindersSectionContext): void {
	const { containerEl, plugin } = context;
	const settings = plugin.remindersSettings;

	createSettingsSectionHeading(containerEl, 'Reminders');

	new Setting(containerEl)
		.setName('Reminders folder')
		.setDesc('Folder where reminder Markdown files are stored')
		.addText(text => {
			let draftValue = settings.remindersFolderPath;

			const commitFolderPath = async (): Promise<void> => {
				const normalizedPath = normalizeRemindersFolderPath(draftValue);
				const currentPath = plugin.remindersSettings.remindersFolderPath;
				text.setValue(normalizedPath);

				if (normalizedPath === currentPath) {
					return;
				}

				await plugin.writeRemindersSettings({ remindersFolderPath: normalizedPath });
				await plugin.reinitializeWithFolder(normalizedPath);
				new Notice(`Reminders folder updated to "${normalizedPath}"`);
			};

			text.setPlaceholder('Reminders')
				.setValue(settings.remindersFolderPath)
				.onChange((value) => {
					draftValue = value;
				});
			text.inputEl.addEventListener('blur', () => {
				void commitFolderPath().catch((error: unknown) => {
					const message = error instanceof Error ? error.message : 'Unknown error';
					new Notice(`Failed to update reminders folder: ${message}`);
					text.setValue(plugin.remindersSettings.remindersFolderPath);
				});
			});
			text.inputEl.addEventListener('keydown', (event: KeyboardEvent) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					text.inputEl.blur();
				}
			});
		});

	new Setting(containerEl)
		.setName('Default due date')
		.setDesc('Fill in a due date when creating new reminders')
		.addDropdown(dropdown => {
			dropdown.addOption('none', 'None');
			dropdown.addOption('today', 'Today');
			dropdown.addOption('tomorrow', 'Tomorrow');
			dropdown.setValue(settings.taskCreationDefaultDueDate)
				.onChange(async (value) => {
					await plugin.writeRemindersSettings({
						taskCreationDefaultDueDate: value as DueDateDefaultSetting,
					});
				});
		});

	new Setting(containerEl)
		.setName('Auto-open view on startup')
		.addDropdown(dropdown => {
			dropdown.addOption('none', 'None');
			dropdown.addOption('sidebar', 'Sidebar');
			dropdown.addOption('fullscreen', 'Full screen');
			dropdown.setValue(settings.autoOpenView)
				.onChange(async (value) => {
					await plugin.writeRemindersSettings({
						autoOpenView: value as AutoOpenSetting,
					});
				});
		});

	new Setting(containerEl)
		.setName('Sidebar default tab')
		.addDropdown(dropdown => {
			dropdown.addOption('inbox', 'Inbox');
			dropdown.addOption('today', 'Today');
			dropdown.addOption('upcoming', 'Upcoming');
			dropdown.addOption('browse', 'Browse');
			dropdown.setValue(settings.sidebarDefaultTab)
				.onChange(async (value) => {
					await plugin.writeRemindersSettings({
						sidebarDefaultTab: value as TabId,
					});
				});
		});

	new Setting(containerEl)
		.setName('Full screen default tab')
		.addDropdown(dropdown => {
			dropdown.addOption('inbox', 'Inbox');
			dropdown.addOption('today', 'Today');
			dropdown.addOption('upcoming', 'Upcoming');
			dropdown.addOption('browse', 'Browse');
			dropdown.setValue(settings.fullscreenDefaultTab)
				.onChange(async (value) => {
					await plugin.writeRemindersSettings({
						fullscreenDefaultTab: value as TabId,
					});
				});
		});

	new Setting(containerEl)
		.setName('Upcoming days')
		.setDesc('Number of days to show in upcoming view')
		.addText(text => {
			text.setValue(String(settings.upcomingDaysDefault))
				.onChange(async (value) => {
					const num = parseInt(value, 10);
					if (!isNaN(num) && num > 0) {
						await plugin.writeRemindersSettings({ upcomingDaysDefault: num });
					}
				});
		});

	new Setting(containerEl)
		.setName('Debug logging')
		.setDesc('Enable verbose reminders logging to console')
		.addToggle(toggle => {
			toggle.setValue(settings.debugLogging)
				.onChange(async (value) => {
					await plugin.writeRemindersSettings({ debugLogging: value });
				});
		});
}
