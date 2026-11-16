import { confirmFeatureFolder, setSharedFeature } from '../../../plugin/feature-settings';
import { Notice, Platform, Setting } from 'obsidian';
import { changeReminderFolder } from '../../plugin-integration';
import {
	normalizeRemindersFolderPath,
	type DueDateDefaultSetting,
	type RemindersSettings,
} from '../../settings';
import type { TabId } from '../shared/layoutConstants';
import { errorMessage } from '../../../platform/logger';
import { FolderSuggest } from '../../../ui/settings/folder-suggest';
import { bindCommittedText, configureIntegerInput, parseSettingInteger } from '../../../ui/settings/input-helpers';
import { normalizeTimeString } from '../../../platform/validation';
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
		.setDesc(`All devices · pause or resume reminders and their notifications. Notes and vault sync are preserved.${plugin.settings.workerUrl ? '' : Platform.isDesktopApp ? ' Connect a server to get notifications on your phone.' : ' Connect a server to get notifications.'}`)
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
			text.setPlaceholder('Reminders')
				.setValue(settings.remindersFolderPath);
			bindCommittedText(text, () => plugin.remindersSettings.remindersFolderPath, async value => {
				const folderPath = normalizeRemindersFolderPath(value);
				if (folderPath === plugin.remindersSettings.remindersFolderPath) return;
				await changeReminderFolder(plugin, folderPath);
				new Notice(`Reminders folder updated to "${folderPath}"`);
				rerender();
			}, undefined, error => `Failed to update reminders folder: ${errorMessage(error)}`);
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
			dropdown.addOption('browse', 'Projects');
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

	if (Platform.isDesktopApp) renderDesktopNotificationSettings(context, viewPreferences, persistSettings);

	return () => folderSuggest?.close();
}

function renderDesktopNotificationSettings(context: SettingsSectionContext, containerEl: HTMLElement, persistSettings: (update: Partial<RemindersSettings>) => Promise<void>): void {
	const { plugin } = context;
	const connected = Boolean(plugin.settings.workerUrl);
	const refresh = () => plugin.reminders?.notifications.refresh();
	new Setting(containerEl)
		.setName('Desktop notifications')
		.setDesc(connected
			? 'This device · show reminders while Obsidian is open. If web app notifications are on in a browser on this computer, turn this off to avoid getting each reminder twice.'
			: 'This device · show reminders while Obsidian is open. Reminders due while Obsidian was closed show when it opens, up to a day late.')
		.addToggle(toggle => toggle
			.setValue(plugin.remindersSettings.desktopNotifications)
			.onChange(async value => {
				await persistSettings({ desktopNotifications: value });
				refresh();
			}));
	// With a server, the shared notification policy in Notifications owns this time.
	if (connected) return;
	new Setting(containerEl)
		.setName('All-day notification time')
		.setDesc('This device · when reminders without a time notify. Leave empty to skip them.')
		.addText(text => {
			text.inputEl.type = 'time';
			text.setPlaceholder('09:00').setValue(plugin.remindersSettings.allDayNotificationTime ?? '');
			bindCommittedText(text, () => plugin.remindersSettings.allDayNotificationTime ?? '', async value => {
				await persistSettings({ allDayNotificationTime: value ? normalizeTimeString(value) : null });
				refresh();
			}, value => value === '' || normalizeTimeString(value) !== null);
		});
}
