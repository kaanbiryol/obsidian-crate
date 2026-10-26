import { expect, it } from 'vitest';
import { isMarkdownNoteInFolder, isMarkdownPath } from './note-paths';
import { isInRemindersFolder } from '@/reminders/data/vaultScanner';
import { isEnrolledReminderNotePath } from '@/reminders/core/reminderFileCommand';

it.each(['Note.md', 'Note.MD', 'a/b.Md', '.md'])('treats %j as Markdown', path => expect(isMarkdownPath(path)).toBe(true));
it.each(['Note', 'Note.markdown', 'Note.md.txt', 'md'])('does not treat %j as Markdown', path => expect(isMarkdownPath(path)).toBe(false));

// Each reminder scope check answers for its own boundary on top of the shared
// folder-and-extension rule: vault events normalize the path and skip conflict
// copies, and web commands reject unsafe segments. The Worker's checks are
// recorded in cloudflare/worker/reminders/scope.test.ts.
const answers = {
	// path: [shared rule, vault events, web command]
	'Reminders/Inbox.md': [true, true, true],
	'Reminders/Inbox.MD': [true, true, true],
	'Reminders/sub/Inbox.md': [true, true, true],
	'Reminders/.md': [true, true, true],
	'Reminders': [false, true, false],
	'Reminders/notes.txt': [false, true, false],
	'Other/Inbox.md': [false, false, false],
	'RemindersX/Inbox.md': [false, false, false],
	'Reminders/./Inbox.md': [true, true, false],
	'Reminders/../Secret.md': [true, true, false],
	'Reminders//Inbox.md': [true, true, false],
	'Reminders/a\\b.md': [true, true, false],
	'/Reminders/Inbox.md': [false, true, false],
	'Reminders/Inbox (conflict 2026-01-01 10-00-00 ab12).md': [true, false, true],
	' Reminders/Inbox.md': [false, false, false],
} satisfies Record<string, [boolean, boolean, boolean]>;

it.each(Object.entries(answers))('scopes %j to the reminders folder in the plugin', (path, expected) => {
	expect([
		isMarkdownNoteInFolder(path, 'Reminders'),
		isInRemindersFolder(path, 'Reminders'),
		isEnrolledReminderNotePath(path, 'Reminders'),
	]).toEqual(expected);
});
