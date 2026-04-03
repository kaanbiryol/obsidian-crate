import { describe, expect, it } from 'vitest';
import {
	DEFAULT_REMINDERS_FOLDER_PATH,
	DEFAULT_REMINDERS_SETTINGS,
	normalizeRemindersFolderPath,
	normalizeRemindersSettings,
} from './settings';

describe('normalizeRemindersSettings', () => {
	it('normalizes persisted reminders settings defensively', () => {
		const settings = normalizeRemindersSettings({
			debugLogging: false,
			taskCreationDefaultDueDate: 'tomorrow',
			remindersFolderPath: ' /Reminders/Work/ ',
			queryViewPreferences: {
				today: { showCompleted: true },
				broken: { showCompleted: 'yes' },
			} as never,
			upcomingDaysDefault: 14,
			autoOpenView: 'fullscreen',
			sidebarDefaultTab: 'today',
			fullscreenDefaultTab: 'browse',
		});

		expect(settings).toEqual({
			debugLogging: false,
			taskCreationDefaultDueDate: 'tomorrow',
			remindersFolderPath: 'Reminders/Work',
			queryViewPreferences: {
				today: { showCompleted: true },
			},
			upcomingDaysDefault: 14,
			autoOpenView: 'fullscreen',
			sidebarDefaultTab: 'today',
			fullscreenDefaultTab: 'browse',
		});
	});

	it('falls back to safe defaults for malformed reminders settings', () => {
		const settings = normalizeRemindersSettings({
			debugLogging: 'nope' as never,
			taskCreationDefaultDueDate: 'later' as never,
			remindersFolderPath: '   ',
			queryViewPreferences: 'broken' as never,
			upcomingDaysDefault: 0,
			autoOpenView: 'modal' as never,
			sidebarDefaultTab: 'other' as never,
			fullscreenDefaultTab: 'other' as never,
		});

		expect(settings).toEqual(DEFAULT_REMINDERS_SETTINGS);
	});

	it('rejects unsafe reminders folder paths and normalizes Windows separators', () => {
		expect(normalizeRemindersFolderPath('Reminders\\Work')).toBe('Reminders/Work');
		expect(normalizeRemindersFolderPath('../Secrets')).toBe(DEFAULT_REMINDERS_FOLDER_PATH);
		expect(normalizeRemindersFolderPath('Reminders//Nested')).toBe(DEFAULT_REMINDERS_FOLDER_PATH);
		expect(normalizeRemindersFolderPath('Reminders/\u0000Hidden')).toBe(DEFAULT_REMINDERS_FOLDER_PATH);
	});
});
