import { describe, expect, it } from 'vitest';
import { presentReminderSourceIssues } from './reminder-source-issue-presentation';

describe('reminder source issue presentation', () => {
	it.each(['Invalid reminder description block on line 8', 'Invalid reminder description block on line 8.', 'Invalid reminder description encoding on line 8'])('humanizes %s', reason => {
		const issue = { path: 'Reminders/Inbox.md', reason };
		expect(presentReminderSourceIssues([issue])).toEqual([{
			...issue, title: 'Couldn’t read one reminder', location: 'Inbox.md · line 8',
			description: 'This reminder has an invalid description.',
		}]);
	});

	it('retains the distinction between an invalid description and an unsupported format', () => {
		expect(presentReminderSourceIssues([{ path: 'Reminders/Inbox.md', reason: 'Unsupported reminder description encoding on line 12' }])[0])
			.toMatchObject({ location: 'Inbox.md · line 12', description: 'This reminder’s description uses an unsupported format.' });
	});

	it('shows full paths when affected filenames are ambiguous', () => {
		const issues = ['Reminders/Work/Inbox.md', 'Reminders/Personal/inbox.md', 'Reminders/Other.md']
			.map(path => ({ path, reason: 'Invalid reminder description block on line 8' }));
		expect(presentReminderSourceIssues(issues).map(issue => issue.location))
			.toEqual(['Reminders/Work/Inbox.md · line 8', 'Reminders/Personal/inbox.md · line 8', 'Other.md · line 8']);
	});

	it('preserves unknown diagnostics and does not invent a line number', () => {
		const issue = { path: 'Reminders/Inbox.md', reason: 'Storage is temporarily unavailable. Try again.' };
		expect(presentReminderSourceIssues([issue])[0]).toMatchObject({ ...issue, location: 'Inbox.md', description: issue.reason, title: 'Couldn’t refresh reminders' });
	});

	it('retains both requirements for recovering an unreadable text file', () => {
		expect(presentReminderSourceIssues([{ path: 'Reminders/Inbox.md', reason: 'Save this note as UTF-8 without null characters before editing its reminders. The original vault file remains synced.' }])[0])
			.toMatchObject({ title: 'Couldn’t read this note', description: 'Save this note as UTF-8 text without null characters.', location: 'Inbox.md' });
	});
});
