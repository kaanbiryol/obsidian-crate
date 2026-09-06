import { describe, expect, it, vi } from 'vitest';
import type { Reminder } from '../../types';
import { buildReminderSubmission, executeReminderAction } from './reminderMutation';

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
	return {
		id: 'r1',
		content: 'Task',
		priority: 4,
		completed: false,
		project: 'Inbox',
		...overrides,
	};
}

describe('buildReminderSubmission', () => {
    it('saves the active chips and clears a stale recurrence when a date replaces it', () => {
        const submission = buildReminderSubmission({
            content: 'Task #Personal #Work ! ! weekly 2026-04-03',
            projects: ['Personal', 'Work'], priority: 4, project: 'Personal', dueDate: null,
            recurrence: { frequency: 'weekly' },
        });
        expect(submission).toMatchObject({
            content: 'Task', project: 'Work', priority: 1, dueDate: '2026-04-03', recurrence: undefined,
        });
    });

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

describe('executeReminderAction', () => {
	it('starts an optimistic action before closing', async () => {
		const events: string[] = [];

		await executeReminderAction({
			close: () => events.push('close'),
			action: async () => {
				events.push('action');
			},
		});

		expect(events).toEqual(['action', 'close']);
	});

	it('closes a non-optimistic action only after it succeeds', async () => {
		const close = vi.fn();
		const onError = vi.fn();

		await executeReminderAction({
			close,
			action: async () => undefined,
			onError,
		});

		expect(close).toHaveBeenCalledOnce();
		expect(onError).not.toHaveBeenCalled();
	});

	it('keeps a non-optimistic action open when persistence fails', async () => {
		const close = vi.fn();
		const onError = vi.fn();
		const error = new Error('save failed');

		await executeReminderAction({
			close,
			action: async () => {
				throw error;
			},
			onError,
		});

		expect(close).not.toHaveBeenCalled();
		expect(onError).toHaveBeenCalledWith(error);
	});
});
