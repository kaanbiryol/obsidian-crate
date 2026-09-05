import { Notice, Setting } from 'obsidian';
import type CratePlugin from '../../main';
import {
	normalizeRemindersFolderPath,
	type DueDateDefaultSetting,
	type RemindersSettings,
} from '../../reminders/settings';
import type { TabId } from '../../reminders/ui/layoutConstants';
import { errorMessage } from '../../plugin/logger';
import { RemindersFolderSuggest } from './folder-suggest';
import { renderRemindersWebApp } from './reminders-web-app';
import { bindCommittedText, configureIntegerInput, parseSettingInteger } from './input-helpers';
import { createSettingsSectionHeading } from './section-helpers';

export interface RemindersSectionContext {
	containerEl: HTMLElement;
	plugin: CratePlugin;
	rerender: () => void;
}

export function renderRemindersSection(context: RemindersSectionContext): () => void {
	const { containerEl, plugin, rerender } = context;
	const settings = plugin.remindersSettings;
	const persistSettings = async (update: Partial<RemindersSettings>): Promise<void> => {
		try {
			await plugin.writeRemindersSettings(update);
		} catch (error) {
			new Notice(`Failed to save reminders settings: ${errorMessage(error)}`);
			rerender();
		}
	};

	createSettingsSectionHeading(containerEl, 'Reminders');
	let folderSuggest: RemindersFolderSuggest;

	new Setting(containerEl)
		.setName('Reminders folder')
		.setDesc('The vault folder containing your reminder files. Changing this folder does not move existing files.')
		.addText(text => {
			folderSuggest = new RemindersFolderSuggest(plugin.app, text.inputEl);

			const commitFolderPath = async (): Promise<void> => {
				const normalizedPath = normalizeRemindersFolderPath(text.inputEl.value);
				const currentPath = plugin.remindersSettings.remindersFolderPath;
				text.setValue(normalizedPath);

				if (normalizedPath === currentPath) {
					return;
				}

				await plugin.writeRemindersSettings({ remindersFolderPath: normalizedPath });
				if (plugin.remindersSettings.enabled) {
					await plugin.reinitializeWithFolder(normalizedPath);
				}
				new Notice(`Reminders folder updated to "${normalizedPath}"`);
			};

			text.setPlaceholder('Reminders')
				.setValue(settings.remindersFolderPath);
			text.inputEl.addEventListener('blur', () => {
				void commitFolderPath().catch((error: unknown) => {
					new Notice(`Failed to update reminders folder: ${errorMessage(error)}`);
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

	if (!settings.enabled) {
		new Setting(containerEl)
			.setName('Enable reminders')
			.setDesc('Use this folder for reminders. Crate scans its Markdown files and adds ID comments to checkbox lines to track reminders when they change.')
			.addButton(button => {
				button.setButtonText('Enable reminders')
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						try {
							await plugin.enableReminders();
							new Notice('Reminders enabled');
							rerender();
						} catch (error) {
							new Notice(`Failed to enable reminders: ${errorMessage(error)}`);
							button.setDisabled(false);
						}
					});
			});
		renderRemindersWebApp(containerEl, plugin);
		return () => folderSuggest.close();
	}

	new Setting(containerEl)
		.setName('Default due date')
		.setDesc('Choose the due date filled in for new reminders.')
		.addDropdown(dropdown => {
			dropdown.addOption('none', 'None');
			dropdown.addOption('today', 'Today');
			dropdown.addOption('tomorrow', 'Tomorrow');
			dropdown.setValue(settings.taskCreationDefaultDueDate)
				.onChange(async (value) => {
					await persistSettings({
						taskCreationDefaultDueDate: value as DueDateDefaultSetting,
					});
				});
		});

	new Setting(containerEl)
		.setName('Upcoming range (days)')
		.setDesc('How many days ahead to show in the upcoming view.')
		.addText(text => {
			text.setValue(String(settings.upcomingDaysDefault));
			configureIntegerInput(text, 1);
			bindCommittedText(text, () => String(plugin.remindersSettings.upcomingDaysDefault),
				value => persistSettings({ upcomingDaysDefault: Number(value) }),
				value => parseSettingInteger(value, 1) !== null);
		});

	new Setting(containerEl)
		.setName('Open reminders on startup')
		.setDesc('Open the reminders view when Obsidian starts.')
		.addToggle(toggle => toggle
			.setValue(settings.autoOpenView === 'sidebar')
			.onChange(async value => {
				await persistSettings({ autoOpenView: value ? 'sidebar' : 'none' });
			}));

	new Setting(containerEl)
		.setName('Default reminders tab')
		.setDesc('The tab shown when you open the reminders view.')
		.addDropdown(dropdown => {
			dropdown.addOption('inbox', 'Inbox');
			dropdown.addOption('today', 'Today');
			dropdown.addOption('upcoming', 'Upcoming');
			dropdown.addOption('browse', 'Browse');
			dropdown.setValue(settings.sidebarDefaultTab)
				.onChange(async (value) => {
					await persistSettings({
						sidebarDefaultTab: value as TabId,
					});
				});
		});

	renderRemindersWebApp(containerEl, plugin);
	return () => folderSuggest.close();
}
