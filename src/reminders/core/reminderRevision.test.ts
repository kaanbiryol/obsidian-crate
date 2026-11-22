import { describe, expect, it } from 'vitest';
import { reminderRevision } from './reminderRevision';

// Web apps cache revisions and send them back with edits, so a reminder that did not
// change must keep the revision released clients computed. These were hashed by 0.14.3.
describe('reminderRevision', () => {
	it.each([
		['a dated reminder', { id: 'r1', filePath: 'Reminders/Inbox.md', content: 'Pay the bill', dueDate: '2099-01-02', priority: 4, completed: false },
			'd1aa5b5f68fc477c4421e4c102215188bc45894496b2deb4a21298de55bd1d3a'],
		['a completed recurring reminder', {
			id: 'r2', filePath: 'Reminders/Home.md', content: 'Water plants', dueDatetime: '2099-01-02T08:00:00.000Z', priority: 1, completed: true, project: 'Home',
			recurrence: { frequency: 'weekly', interval: 2, daysOfWeek: [3, 1], completedCount: 3, hour: 8, minute: 0, timezone: 'Europe/Berlin' },
		}, '8957e217932be39ca99cd64cb05e866a50a92a0912d3ee5af621370c63549f0f'],
	] as const)('keeps the released revision of %s', async (_label, reminder, revision) => {
		await expect(reminderRevision(reminder)).resolves.toBe(revision);
	});

	it('changes when a completion time is recorded', async () => {
		const reminder = { id: 'r1', content: 'Pay the bill', priority: 4, completed: true } as const;
		expect(await reminderRevision({ ...reminder, completedAt: '2099-01-02T09:00:00.000Z' })).not.toBe(await reminderRevision(reminder));
	});
});
