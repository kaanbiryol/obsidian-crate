import { confirmFeatureFolder, setSharedFeature } from '../../../plugin/feature-settings';
import { Notice, Setting } from 'obsidian';
import { changeReminderFolder } from '../../notification-policy-sync';
import {
	normalizeRemindersFolderPath,
	type DueDateDefaultSetting,
	type RemindersSettings,
} from '../../settings';
import type { TabId } from '../shared/layoutConstants';
import { errorMessage } from '../../../platform/logger';
import { FolderSuggest } from '../../../ui/settings/folder-suggest';
import { bindCommittedText, configureIntegerInput, parseSettingInteger } from '../../../ui/settings/input-helpers';
import { createSettingsDisclosure } from '../../../ui/plugin/settings-disclosure';
import type { SettingsSectionContext } from '../../../ui/settings/section-helpers';

export function renderRemindersSettings(context: SettingsSectionContext): () => void {
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
	const preferences = createSettingsDisclosure(containerEl, 'Reminders', {
		summary: settings.enabled ? `Folder: ${settings.remindersFolderPath}` : settings.confirmed ? 'Paused' : 'Off',
	});

	new Setting(preferences).setName('Enable reminders')
		.setDesc(`All devices · pause or resume reminders and their notifications. Notes and vault sync are preserved.${plugin.settings.workerUrl ? '' : ' Connect a server to get notifications.'}`)
		.addToggle(toggle => toggle.setValue(settings.enabled).onChange(async enabled => {
			toggle.setDisabled(true);
			try {
				if (!enabled || await confirmFeatureFolder(plugin, 'reminders')) await setSharedFeature(plugin, 'reminders', enabled);
			}
			catch (error) { new Notice(`Could not change reminders: ${errorMessage(error)}`); }
			finally { rerender(); }
		}));

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

	if (!settings.enabled) return () => folderSuggest?.close();
	const viewPreferences = preferences.createDiv();

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
