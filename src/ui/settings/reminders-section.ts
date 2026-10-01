import { setSharedFeature } from '../../plugin/feature-settings';
import { Notice, Setting } from 'obsidian';
import { changeReminderFolder } from '../../reminders/notification-policy-sync';
import type CratePlugin from '../../main';
import {
	normalizeRemindersFolderPath,
	type DueDateDefaultSetting,
	type RemindersSettings,
} from '../../reminders/settings';
import type { TabId } from '../../reminders/ui/layoutConstants';
import { normalizeReminderListStyle } from '../../reminders/types/reminder-list-style';
import { errorMessage } from '../../plugin/logger';
import { FolderSuggest } from './folder-suggest';
import { bindCommittedText, configureIntegerInput, parseSettingInteger } from './input-helpers';
import { createSettingsDisclosure } from './section-helpers';

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

	let folderSuggest: FolderSuggest | undefined;
	const preferences = createSettingsDisclosure(containerEl, 'Reminders', { summary: settings.enabled ? `Folder: ${settings.remindersFolderPath}` : 'Paused' });

	new Setting(preferences).setName('Enable reminders')
		.setDesc('All devices · pause or resume reminders and their notifications. Notes and vault sync are preserved.')
		.addToggle(toggle => toggle.setValue(settings.enabled).onChange(async enabled => {
			toggle.setDisabled(true);
			try { await setSharedFeature(plugin, 'reminders', enabled); }
			catch (error) { new Notice(`Could not change reminders: ${errorMessage(error)}`); }
			finally { rerender(); }
		}));
	if (!settings.enabled) return () => {};

	new Setting(preferences)
		.setName('Reminders folder')
		.setDesc('Crate scans this folder and adds hidden tracking IDs to checkbox lines. Changes reach the server when connected. Files are not moved.')
		.addText(text => {
			folderSuggest = new FolderSuggest(plugin.app, text.inputEl);

			const commitFolderPath = async (): Promise<void> => {
				const normalizedPath = normalizeRemindersFolderPath(text.inputEl.value);
				const currentPath = plugin.remindersSettings.remindersFolderPath;
				text.setValue(normalizedPath);

				if (normalizedPath === currentPath) {
					return;
				}

				await changeReminderFolder(plugin, normalizedPath);
				new Notice(`Reminders folder updated to "${normalizedPath}"`);
				rerender();
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

	const viewPreferences = preferences.createDiv();

	new Setting(viewPreferences)
		.setName('Reminder list style')
		.setDesc('This device · use flat rows with subtle dividers or individual cards, including in notes.')
		.addDropdown(dropdown => dropdown
			.addOption('flat', 'Flat')
			.addOption('cards', 'Cards')
			.setValue(settings.listStyle)
			.onChange(value => persistSettings({ listStyle: normalizeReminderListStyle(value) })));

	new Setting(viewPreferences)
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

	return () => folderSuggest?.close();
}
