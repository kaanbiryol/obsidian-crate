import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Reminder } from '../../types';
import { buildReminderSubmission, executeReminderAction } from './reminderMutation';
import { buildReminderUpdate } from '../../data/reminder-repository/shared';
import { buildUpdatedReminderBlock } from '../../core/markdownReminderMutation';

afterEach(() => vi.useRealTimers());

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
    it.each(['', ' \u00a0 ', 'tomorrow', '09:00', 'every Monday', 'every week Monday 09:00', '#Work', '!',
        'every Monday 09:00 #Work !', '#Work\u00a0!\u00a0tomorrow'])('blocks titleless creation and editing: %j', content => {
        for (const reminder of [undefined, makeReminder({ dueDate: '2026-09-28' })]) {
            expect(buildReminderSubmission({
                content, description: 'A description does not replace the title',
                projects: ['Inbox', 'Work'], priority: 4, project: 'Inbox', dueDate: '2026-09-28', reminder,
            })).toBeNull();
        }
    });

    it.each([
        ['Finish report every Monday 09:00 #Work !', 'Finish report'],
        ['Monday Friday', 'Monday'],
        ['#Home #Work', '#Home'],
        ['! !', '!'],
        ['[Monday](https://example.com) every Friday', '[Monday](https://example.com)'],
    ])('allows a real title, including earlier literal tokens: %s', (content, expectedTitle) => {
        expect(buildReminderSubmission({ content, projects: ['Inbox', 'Work'],
            priority: 4, project: 'Inbox', dueDate: null })?.content).toBe(expectedTitle);
    });

    it.each([
        [{ frequency: 'weekly' as const, daysOfWeek: [2], hour: 10, minute: 0, timezone: 'UTC' }, 'Task every Tuesday 10:00', '2026-09-22T10:00:00.000Z'],
        [{ frequency: 'weekly' as const, daysOfWeek: [1], timezone: 'UTC' }, 'Task every Monday', undefined],
    ])('recalculates the occurrence after the draft changes recurrence: %s', (recurrence, content, dueDatetime) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-21T13:00:00Z'));
        const reminder = makeReminder({ dueDatetime: '2026-09-28T09:00:00.000Z',
            recurrence: { frequency: 'weekly', daysOfWeek: [1], hour: 9, minute: 0, timezone: 'UTC' } });
        const submission = buildReminderSubmission({
            content: `${content} UTC`, projects: [], priority: 4, project: 'Inbox', dueDate: null, hasTime: false, recurrence, reminder,
        })!;
        expect(submission.updatedReminder?.dueDate).toBeUndefined();
        expect(submission.updatedReminder?.dueDatetime).toBeUndefined();
        const { updates } = buildReminderUpdate(submission.updatedReminder!);
        const stored = buildUpdatedReminderBlock({ ...reminder, rawLine: '- [ ] Task', lineNumber: 0, filePath: 'Inbox.md' }, updates);
        expect(stored.recurrence).toEqual(recurrence);
        expect(stored.dueDatetime).toBe(dueDatetime);
        expect(stored.dueDateKey).toBe(dueDatetime ? '2026-09-22' : '2026-09-21');
    });

    it('keeps the exact occurrence and recurrence metadata when editing only the title', () => {
        const recurrence = { frequency: 'weekly' as const, daysOfWeek: [1], hour: 9, minute: 0,
            timezone: 'UTC', count: 5, completedCount: 2 };
        const reminder = makeReminder({ dueDatetime: '2026-10-05T09:00:37.123Z', recurrence });
        const submission = buildReminderSubmission({
            content: 'Renamed task every Monday 09:00 UTC', projects: [], priority: 4, project: 'Inbox',
            dueDate: reminder.dueDatetime!, hasTime: true, recurrence, reminder,
        })!;
        expect(submission.updatedReminder).toMatchObject({ content: 'Renamed task', dueDatetime: reminder.dueDatetime, recurrence });
    });

    it('saves an unmatched calendar phrase as an unscheduled title', () => {
        const content = 'Task February 30 at 9 in the morning';
        expect(buildReminderSubmission({ content, projects: [], priority: 4, project: 'Inbox', dueDate: null }))
            .toMatchObject({ content, dueDate: undefined, recurrence: undefined });
    });

    it('saves the active chips and clears a stale recurrence when a date replaces it', () => {
        const submission = buildReminderSubmission({
            content: 'Task #Personal #Work ! ! weekly 2026-04-03',
            projects: ['Personal', 'Work'], priority: 4, project: 'Personal', dueDate: null,
            recurrence: { frequency: 'weekly' },
        });
        expect(submission).toMatchObject({
            content: 'Task #Personal ! weekly', project: 'Work', priority: 1, dueDate: '2026-04-03', recurrence: undefined,
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
