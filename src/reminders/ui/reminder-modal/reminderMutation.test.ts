import { describe, expect, it } from 'vitest';
import type { Reminder } from '../../types';
import { buildReminderSubmission } from './reminderMutation';

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
	return {
		id: 'r1',
		content: 'Task',
		priority: 4,
		completed: false,
		project: 'Inbox',
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

describe('buildReminderSubmission', () => {
	it('keeps ISO date-only reminders as date-only values', () => {
		const submission = buildReminderSubmission({
			content: 'Task 2026-04-03',
			projects: [],
			priority: 4,
			project: 'Inbox',
			dueDate: null,
			reminder: makeReminder(),
		});

		expect(submission).not.toBeNull();
		expect(submission?.dueDate).toBe('2026-04-03');
		expect(submission?.hasTime).toBe(false);
		expect(submission?.updatedReminder?.dueDate).toBe('2026-04-03');
		expect(submission?.updatedReminder?.dueDatetime).toBeUndefined();
	});
});
