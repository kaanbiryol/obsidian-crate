import { describe, expect, it } from 'vitest';
import {
	DEFAULT_REMINDERS_FOLDER_PATH,
	DEFAULT_REMINDERS_SETTINGS,
	normalizeRemindersFolderPath,
	normalizeRemindersSettings,
} from './settings';
import { normalizeTimeString } from '../platform/validation';

describe('normalizeRemindersSettings', () => {
	it('normalizes persisted reminders settings defensively', () => {
		const settings = normalizeRemindersSettings({
			enabled: true,
			confirmed: true,
			taskCreationDefaultDueDate: 'tomorrow',
			remindersFolderPath: ' /Reminders/Work/ ',
			upcomingDaysDefault: 14,
			autoOpenView: 'sidebar',
			sidebarDefaultTab: 'today',
			allDayNotificationTime: '09:00',
		});

		expect(settings).toEqual({
			enabled: true,
			confirmed: true,
			listStyle: 'flat',
			taskCreationDefaultDueDate: 'tomorrow',
			remindersFolderPath: 'Reminders/Work',
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
			upcomingDaysDefault: 0,
			autoOpenView: 'modal' as never,
			sidebarDefaultTab: 'other' as never,
		});

		expect(settings).toEqual(DEFAULT_REMINDERS_SETTINGS);
	});

	it('starts a fresh install with reminders off and unconfirmed', () => {
		expect(DEFAULT_REMINDERS_SETTINGS).toMatchObject({ enabled: false, confirmed: false });
	});

	it.each([undefined, null, {}])('uses the fresh-install defaults when settings are %s', saved => {
		expect(normalizeRemindersSettings(saved)).toEqual(DEFAULT_REMINDERS_SETTINGS);
	});

	it('never runs reminders in a vault that has not confirmed them', () => {
		expect(normalizeRemindersSettings({ enabled: true, confirmed: false })).toMatchObject({ enabled: false, confirmed: false });
	});

	it('drops retired embedded-block preferences from saved settings', () => {
		const saved = { enabled: false, confirmed: true, queryViewPreferences: { abc123: { showCompleted: true } } };
		const settings = normalizeRemindersSettings(saved);
		expect(settings).not.toHaveProperty('queryViewPreferences');
		expect(settings).toEqual({ ...DEFAULT_REMINDERS_SETTINGS, enabled: false, confirmed: true });
	});

	it('preserves explicitly disabled Reminders', () => {
		expect(normalizeRemindersSettings({ enabled: false, confirmed: true }).enabled).toBe(false);
	});

	it.each(['flat', 'cards'] as const)('preserves the %s list style', listStyle => {
		expect(normalizeRemindersSettings({ listStyle }).listStyle).toBe(listStyle);
	});

	it.each([undefined, null, 'compact', 1])('defaults missing or invalid list styles to flat: %s', listStyle => {
		expect(normalizeRemindersSettings({ listStyle } as never).listStyle).toBe('flat');
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
