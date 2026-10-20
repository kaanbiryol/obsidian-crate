import { expect, it } from 'vitest';
import { parseReminderSourceIssues } from './reminder-source-issues';

it('retains valid file explanations and accepts absent legacy metadata', () => {
	const issues = [{ path: 'Reminders/Inbox.md', reason: 'Duplicate reminder ID' }];
	expect(parseReminderSourceIssues(issues)).toEqual(issues);
	expect(parseReminderSourceIssues(undefined)).toEqual([]);
});

it.each([null, {}, 'incomplete', [null], [{ path: 'Reminders/Broken.md' }], [{ path: '', reason: 'Unknown source' }]])('rejects damaged metadata instead of reporting complete data: %j', value => {
	expect(parseReminderSourceIssues(value)).toBeNull();
});
