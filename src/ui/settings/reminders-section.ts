import { Notice, Setting } from 'obsidian';
import { changeReminderFolder } from '../../reminders/notification-policy-sync';
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
	onAllDayTimeContainer?: (container: HTMLElement) => void;
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
	const enableEl = containerEl.createDiv();

	new Setting(containerEl)
		.setName('Reminders folder')
		.setDesc('The folder used for reminders on this device and the server. Changes save on this device immediately and reach the server when connected. Files are not moved.')
		.addText(text => {
			folderSuggest = new RemindersFolderSuggest(plugin.app, text.inputEl);

			const commitFolderPath = async (): Promise<void> => {
				const normalizedPath = normalizeRemindersFolderPath(text.inputEl.value);
				const currentPath = plugin.remindersSettings.remindersFolderPath;
				text.setValue(normalizedPath);

				if (normalizedPath === currentPath) {
					return;
				}

				await changeReminderFolder(plugin, normalizedPath);
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

	new Setting(enableEl)
		.setName('Enable reminders on this device')
		.setDesc(settings.enabled
			? 'This device · turn off to stop scanning and close reminder views. Files and ID comments are kept. Web reminders and server notifications stay active.'
			: 'This device · use this folder for reminders. Crate scans its Markdown files and adds ID comments to checkbox lines to track reminders when they change.')
		.addToggle(toggle => toggle.setValue(settings.enabled).onChange(async enabled => {
			toggle.setDisabled(true);
			try {
				if (enabled) {
					await plugin.enableReminders();
					new Notice('Reminders enabled');
				} else {
					await plugin.disableReminders();
				}
				rerender();
			} catch (error) {
				new Notice(`Failed to ${enabled ? 'enable' : 'disable'} reminders: ${errorMessage(error)}`);
				toggle.setValue(plugin.remindersSettings.enabled).setDisabled(false);
			}
		}));

	renderRemindersWebApp(containerEl, plugin);
	createSettingsSectionHeading(containerEl, 'Reminders preferences');
	const preferences = containerEl.createDiv();
	const allDayTimeEl = containerEl.createDiv();
	context.onAllDayTimeContainer?.(allDayTimeEl);
	const viewPreferences = containerEl.createDiv();

	if (!settings.enabled) return () => folderSuggest.close();

	new Setting(preferences)
		.setName('Default due date')
		.setDesc('This device · choose the due date filled in for new reminders.')
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

	new Setting(viewPreferences)
		.setName('Open reminders on startup')
		.setDesc('This device · open the reminders view when Obsidian starts.')
		.addToggle(toggle => toggle
			.setValue(settings.autoOpenView === 'sidebar')
			.onChange(async value => {
				await persistSettings({ autoOpenView: value ? 'sidebar' : 'none' });
			}));

	new Setting(viewPreferences)
		.setName('Default reminders tab')
		.setDesc('This device · the tab shown when you open the reminders view.')
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

	new Setting(viewPreferences)
		.setName('Upcoming range (days)')
		.setDesc('This device · how many days ahead to show in the upcoming view.')
		.addText(text => {
			text.setValue(String(settings.upcomingDaysDefault));
			configureIntegerInput(text, 1);
			bindCommittedText(text, () => String(plugin.remindersSettings.upcomingDaysDefault),
				value => persistSettings({ upcomingDaysDefault: Number(value) }),
				value => parseSettingInteger(value, 1) !== null);
		});

	return () => folderSuggest.close();
}
