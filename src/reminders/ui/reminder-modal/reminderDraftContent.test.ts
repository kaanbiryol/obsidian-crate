import { describe, expect, it } from 'vitest';
import type { Reminder } from '../../types';
import {
	buildInitialReminderContent,
	rebuildReminderContent,
} from './reminderDraftContent';

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

describe('reminder draft content helpers', () => {
	it('rebuilds existing reminder content with date, project, and priority', () => {
		const content = buildInitialReminderContent(
			makeReminder({
				dueDate: '2026-04-03',
				project: 'Work',
				priority: 1,
			}),
			'Inbox',
		);

		expect(content).toContain('Task');
		expect(content).toContain('Apr 3, 2026');
		expect(content).toContain('#Work');
		expect(content).toContain('!');
	});

	it('uses recurrence text instead of date text', () => {
		const content = buildInitialReminderContent(
			makeReminder({
				dueDate: '2026-04-03',
				recurrence: { frequency: 'daily', hour: 9, minute: 0 },
			}),
			'Inbox',
		);

		expect(content).toContain('daily 09:00');
		expect(content).not.toContain('Apr 3, 2026');
	});

	it('rebuilds content with selected metadata and trailing edit space', () => {
		const content = rebuildReminderContent(
			'Task',
			'2026-04-03T15:30:00.000Z',
			undefined,
			'Work',
			1,
			'Inbox',
			true,
		);

		expect(content).toContain('Task');
		expect(content).toContain('Apr 3, 2026');
		expect(content).toContain('#Work');
		expect(content).toContain('!');
		expect(content.endsWith(' ')).toBe(true);
	});
});
