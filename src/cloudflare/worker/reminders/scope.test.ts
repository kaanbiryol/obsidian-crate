import { expect, it } from 'vitest';
import { isMarkdownNoteInFolder } from '../../../protocol/note-paths';
import { isReminderPath } from './scope';
import { parseReminderSourceFilePath } from './requests';

// The Worker's reminder scope checks on top of the shared folder-and-extension
// rule. Synced paths arrive already validated; request bodies are trimmed and
// sync-path checked. The plugin's checks are in protocol/note-paths.test.ts.
const answers = {
	// path: [shared rule, synced file scope, request body]
	'Reminders/Inbox.md': [true, true, true],
	'Reminders/Inbox.MD': [true, true, true],
	'Reminders/sub/Inbox.md': [true, true, true],
	'Reminders/.md': [true, true, true],
	'Reminders': [false, false, false],
	'Reminders/notes.txt': [false, false, false],
	'Other/Inbox.md': [false, false, false],
	'RemindersX/Inbox.md': [false, false, false],
	'Reminders/./Inbox.md': [true, true, false],
	'Reminders/../Secret.md': [true, true, false],
	'Reminders//Inbox.md': [true, true, false],
	'Reminders/a\\b.md': [true, true, false],
	'/Reminders/Inbox.md': [false, false, false],
	'Reminders/Inbox (conflict 2026-01-01 10-00-00 ab12).md': [true, true, true],
	' Reminders/Inbox.md': [false, false, true],
} satisfies Record<string, [boolean, boolean, boolean]>;

it.each(Object.entries(answers))('scopes %j to the reminders folder in the Worker', (path, expected) => {
	expect([
		isMarkdownNoteInFolder(path, 'Reminders'),
		isReminderPath(path, 'Reminders'),
		parseReminderSourceFilePath(path, 'Reminders') !== null,
	]).toEqual(expected);
});

it('has no reminder scope without a configured folder', () => {
	expect(isReminderPath('Reminders/Inbox.md', null)).toBe(false);
});
