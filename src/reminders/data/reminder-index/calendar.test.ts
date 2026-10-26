import { afterEach, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import { createReminderIndex, type IndexedReminder } from '.';
import { createReminderRepository } from '../reminder-repository';
import { buildTodayViewModel, buildUpcomingViewModel } from '../../ui/views/viewModels';
import { isReminderOverdue } from '../../core/dates/reminderDate';

const originalTimezone = process.env.TZ;
afterEach(() => {
	vi.useRealTimers();
	process.env.TZ = originalTimezone;
});

function reminder(dates: Partial<IndexedReminder>): IndexedReminder {
	return { id: 'task', content: 'Task', completed: false, priority: 4, project: 'Inbox',
		filePath: 'Reminders/Inbox.md', lineNumber: 0, rawLine: '- [ ] Task', ...dates };
}

it.each([
	{ name: 'all-day before midnight', now: '2026-09-08T23:59:59Z', dueDate: '2026-09-09', today: false, overdue: false, upcoming: true },
	{ name: 'all-day at midnight', now: '2026-09-09T00:00:00Z', dueDate: '2026-09-09', today: true, overdue: false, upcoming: false },
	{ name: 'previous all-day', now: '2026-09-09T00:00:00Z', dueDate: '2026-09-08', today: false, overdue: true, upcoming: false },
	{ name: 'future timed today', now: '2026-09-09T12:00:00Z', dueDatetime: '2026-09-09T12:00:01Z', today: true, overdue: false, upcoming: true },
	{ name: 'exact timed deadline', now: '2026-09-09T12:00:00Z', dueDatetime: '2026-09-09T12:00:00Z', today: true, overdue: false, upcoming: false },
	{ name: 'elapsed timed today', now: '2026-09-09T12:00:01Z', dueDatetime: '2026-09-09T12:00:00Z', today: true, overdue: true, upcoming: false },
	{ name: 'completed today', now: '2026-09-09T12:00:00Z', dueDate: '2026-09-09', completed: true, today: true, overdue: false, upcoming: false },
	{ name: 'completed yesterday', now: '2026-09-09T12:00:00Z', dueDate: '2026-09-08', completed: true, today: false, overdue: false, upcoming: false },
	{ name: 'unscheduled', now: '2026-09-09T12:00:00Z', today: false, overdue: false, upcoming: false },
	{ name: 'spring DST next day', zone: 'Europe/Berlin', now: '2026-03-29T00:00:00+01:00', dueDate: '2026-03-30', today: false, overdue: false, upcoming: true },
	{ name: 'spring DST upper bound', zone: 'Europe/Berlin', now: '2026-03-29T00:00:00+01:00', dueDatetime: '2026-03-31T00:00:00+02:00', today: false, overdue: false, upcoming: false },
	{ name: 'autumn DST next day', zone: 'Europe/Berlin', now: '2026-10-25T00:00:00+02:00', dueDate: '2026-10-26', today: false, overdue: false, upcoming: true },
	{ name: 'autumn DST repeated hour', zone: 'Europe/Berlin', now: '2026-10-25T02:30:00+02:00', dueDatetime: '2026-10-25T02:15:00+01:00', today: true, overdue: false, upcoming: true },
])('keeps repository queries and shared views consistent: $name', test => {
	process.env.TZ = test.zone ?? 'UTC';
	vi.useFakeTimers({ toFake: ['Date'] });
	const now = new Date(test.now);
	vi.setSystemTime(now);
	const item = reminder({ dueDate: test.dueDate, dueDatetime: test.dueDatetime, completed: test.completed ?? false });
	const index = createReminderIndex({ vault: {} } as App, 'Reminders');
	index.applyOptimisticCreate(item);
	const repository = createReminderRepository(index, {} as never);
	const inTodayView = !item.completed && (test.today || test.overdue);
	const completedToday = item.completed && test.today;

	expect(isReminderOverdue(item, now)).toBe(test.overdue);
	const today = buildTodayViewModel([item], now);
	expect(today.active).toHaveLength(Number(inTodayView));
	expect(today.completed).toHaveLength(Number(completedToday));
	expect(buildUpcomingViewModel([item], 1, now).upcomingReminders).toHaveLength(Number(test.upcoming));
	expect(repository.getTodayReminders()).toHaveLength(Number(inTodayView));
	expect(repository.getTodayReminders(true)).toHaveLength(Number(inTodayView || completedToday));
});

it('uses one calendar snapshot when midnight falls between repository query stages', () => {
	process.env.TZ = 'UTC';
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-09-08T23:59:59Z'));
	const index = createReminderIndex({ vault: {} } as App, 'Reminders');
	for (const item of [
		reminder({ id: 'today', dueDate: '2026-09-08' }),
		reminder({ id: 'tomorrow', dueDate: '2026-09-09' }),
		reminder({ id: 'done-today', dueDate: '2026-09-08', completed: true }),
		reminder({ id: 'done-tomorrow', dueDate: '2026-09-09', completed: true }),
	]) index.applyOptimisticCreate(item);
	const getAll = index.getAll.bind(index);
	vi.spyOn(index, 'getAll').mockImplementation(() => {
		const result = getAll();
		vi.setSystemTime(new Date('2026-09-09T00:00:00Z'));
		return result;
	});
	const repository = createReminderRepository(index, {} as never);
	expect(repository.getTodayReminders(true).map(item => item.id)).toEqual(['today', 'done-today']);
});
