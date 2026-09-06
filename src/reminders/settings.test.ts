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
			enabled: true,
			taskCreationDefaultDueDate: 'tomorrow',
			remindersFolderPath: ' /Reminders/Work/ ',
			queryViewPreferences: {
				today: { showCompleted: true },
				broken: { showCompleted: 'yes' },
			} as never,
			upcomingDaysDefault: 14,
			autoOpenView: 'sidebar',
			sidebarDefaultTab: 'today',
			allDayNotificationTime: '09:00',
		});

		expect(settings).toEqual({
			enabled: true,
			taskCreationDefaultDueDate: 'tomorrow',
			remindersFolderPath: 'Reminders/Work',
			queryViewPreferences: {
				today: { showCompleted: true },
			},
			upcomingDaysDefault: 14,
			autoOpenView: 'sidebar',
			sidebarDefaultTab: 'today',
			allDayNotificationTime: '09:00',
		});
	});

	it('uses current defaults when settings are malformed', () => {
		const settings = normalizeRemindersSettings({
			taskCreationDefaultDueDate: 'later' as never,
			remindersFolderPath: '   ',
			queryViewPreferences: 'broken' as never,
			upcomingDaysDefault: 0,
			autoOpenView: 'modal' as never,
			sidebarDefaultTab: 'other' as never,
		});

		expect(settings).toEqual({
			...DEFAULT_REMINDERS_SETTINGS,
		});
	});

	it('keeps reminders disabled for a new install until the user opts in', () => {
		expect(normalizeRemindersSettings(undefined)).toEqual(DEFAULT_REMINDERS_SETTINGS);
		expect(normalizeRemindersSettings(null)).toEqual(DEFAULT_REMINDERS_SETTINGS);
	});

	it('preserves an explicit disabled setting', () => {
		expect(normalizeRemindersSettings({ enabled: false }).enabled).toBe(false);
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
		expect(normalizeRemindersFolderPath('Reminders//Nested')).toBe('Reminders/Nested');
		expect(normalizeRemindersFolderPath('Reminders/\u0000Hidden')).toBe(DEFAULT_REMINDERS_FOLDER_PATH);
	});
});
