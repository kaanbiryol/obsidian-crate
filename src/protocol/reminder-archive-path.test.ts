import { describe, expect, it } from 'vitest';
import { isReminderArchivePath, isReminderArchiveProject, isReminderNotePath, reminderArchiveNotePath } from './reminder-archive-path';
import { normalizeReminderProjectPath } from '@/reminders/core/reminderProjectPath';

describe('reminder archive paths', () => {
	it('keeps the archive folder out of project notes in any letter case', () => {
		expect(isReminderNotePath('Reminders/Inbox.md', 'Reminders')).toBe(true);
		expect(isReminderNotePath('Reminders/Archive.md', 'Reminders')).toBe(true);
		expect(isReminderNotePath('Reminders/Archive/Inbox.md', 'Reminders')).toBe(false);
		expect(isReminderNotePath('Reminders/archive/Work/Q1.md', 'Reminders')).toBe(false);
		expect(isReminderArchivePath('Reminders/Work/Archive/Q1.md', 'Reminders')).toBe(false);
		expect(isReminderArchivePath('Other/Archive/Inbox.md', 'Reminders')).toBe(false);
	});

	it('maps a project note to its archive note', () => {
		expect(reminderArchiveNotePath('Notes/Reminders', 'Notes/Reminders/Work/Q1.md')).toBe('Notes/Reminders/Archive/Work/Q1.md');
	});

	it('rejects projects inside the archive but allows a project named Archive', () => {
		expect(isReminderArchiveProject('Archive/Inbox')).toBe(true);
		expect(isReminderArchiveProject('ARCHIVE/Inbox')).toBe(true);
		expect(normalizeReminderProjectPath('Archive/Inbox')).toBeNull();
		expect(normalizeReminderProjectPath('Archive')).toBe('Archive');
		expect(normalizeReminderProjectPath('Work/Archive')).toBe('Work/Archive');
	});
});
