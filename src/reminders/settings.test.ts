import { describe, expect, it } from 'vitest';
import {
	DEFAULT_REMINDERS_FOLDER_PATH,
	DEFAULT_REMINDERS_SETTINGS,
	normalizeRemindersFolderPath,
	normalizeRemindersSettings,
	normalizeTimeString,
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
			allDayNotificationTime: '09:00',
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
			allDayNotificationTime: '09:00',
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

	it('normalizes allDayNotificationTime values', () => {
		expect(normalizeTimeString('09:00')).toBe('09:00');
		expect(normalizeTimeString('23:59')).toBe('23:59');
		expect(normalizeTimeString('00:00')).toBe('00:00');
		expect(normalizeTimeString(' 09:00 ')).toBe('09:00');
		expect(normalizeTimeString('25:00')).toBeNull();
		expect(normalizeTimeString('9:00')).toBeNull();
		expect(normalizeTimeString('abc')).toBeNull();
		expect(normalizeTimeString(null)).toBeNull();
		expect(normalizeTimeString(undefined)).toBeNull();
		expect(normalizeTimeString(42)).toBeNull();
	});

	it('rejects unsafe reminders folder paths and normalizes Windows separators', () => {
		expect(normalizeRemindersFolderPath('Reminders\\Work')).toBe('Reminders/Work');
		expect(normalizeRemindersFolderPath('../Secrets')).toBe(DEFAULT_REMINDERS_FOLDER_PATH);
		expect(normalizeRemindersFolderPath('Reminders//Nested')).toBe(DEFAULT_REMINDERS_FOLDER_PATH);
		expect(normalizeRemindersFolderPath('Reminders/\u0000Hidden')).toBe(DEFAULT_REMINDERS_FOLDER_PATH);
	});
});
