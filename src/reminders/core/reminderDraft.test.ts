import { describe, expect, it } from 'vitest';
import type { Reminder } from '../types';
import {
	applyReminderDraftContentUpdate,
	buildInitialReminderContent,
	deriveReminderDraftContentMetadata,
	rebuildReminderContent,
} from './reminderDraft';

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

	it('derives inline metadata through one shared parser boundary', () => {
		const metadata = deriveReminderDraftContentMetadata(
			'Finish report #Work ! 2026-04-03',
			['Inbox', 'Work'],
			'Inbox',
		);

		expect(metadata).toMatchObject({
			cleanContent: 'Finish report',
			dueDate: '2026-04-03',
			hasDate: true,
			recurrence: undefined,
			project: 'Work',
			hasProject: true,
			priority: 1,
			hasPriorityMarker: true,
			hasTime: false,
		});
	});

	it('treats recurrence as mutually exclusive with a due date', () => {
		const metadata = deriveReminderDraftContentMetadata(
			'Plan daily 09:00',
			['Inbox'],
			'Inbox',
		);

		expect(metadata.dueDate).toBeNull();
		expect(metadata.recurrence).toMatchObject({ frequency: 'daily', hour: 9, minute: 0 });
		expect(metadata.hasTime).toBe(false);
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

	it('composes rapid project and priority updates from the latest draft', () => {
		const initial = {
			content: 'Task',
			dueDate: null,
			recurrence: undefined,
			project: 'Inbox',
			priority: 4 as const,
			hasTime: false,
		};
		const withProject = applyReminderDraftContentUpdate(
			initial,
			{ project: 'Work' },
			['Inbox', 'Work'],
			'Inbox',
		);
		const withPriority = applyReminderDraftContentUpdate(
			withProject,
			{ priority: 1 },
			['Inbox', 'Work'],
			'Inbox',
		);

		expect(withPriority.project).toBe('Work');
		expect(withPriority.priority).toBe(1);
		expect(withPriority.content).toContain('#Work');
		expect(withPriority.content).toContain('!');
	});

	it('replaces a selected date with recurrence in one transaction', () => {
		const initial = {
			content: 'Task Apr 3, 2026',
			dueDate: '2026-04-03',
			recurrence: undefined,
			project: 'Inbox',
			priority: 4 as const,
			hasTime: false,
		};
		const recurrence = { frequency: 'daily' as const, hour: 9, minute: 0 };
		const updated = applyReminderDraftContentUpdate(
			initial,
			{ recurrence, dueDate: null },
			['Inbox'],
			'Inbox',
		);

		expect(updated.dueDate).toBeNull();
		expect(updated.recurrence).toEqual(recurrence);
		expect(updated.content).toContain('daily 09:00');
		expect(updated.content).not.toContain('Apr 3, 2026');
	});
});
