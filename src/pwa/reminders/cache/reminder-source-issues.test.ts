import { expect, it } from 'vitest';
import { parseReminderSourceIssues } from './reminder-source-issues';

it('retains valid file explanations', () => {
	const issues = [{ path: 'Reminders/Inbox.md', reason: 'Duplicate reminder ID' }];
	expect(parseReminderSourceIssues(issues)).toEqual(issues);
});

it.each([undefined, null, {}, 'incomplete', [null], [{ path: 'Reminders/Broken.md' }], [{ path: '', reason: 'Unknown source' }]])('rejects damaged metadata instead of reporting complete data: %j', value => {
	expect(parseReminderSourceIssues(value)).toBeNull();
});
