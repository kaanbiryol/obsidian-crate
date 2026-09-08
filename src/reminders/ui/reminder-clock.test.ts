import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getLocalTimeZone, resetLocalTimeZone } from '@internationalized/date';
import { createReminderClock } from './reminder-clock';
import { buildTodayViewModel, buildUpcomingViewModel } from './views/viewModels';
import { getRemindersHeaderData } from './remindersViewModel';
import { formatDueDate, isReminderOverdue } from '../utils/dateFormatting';
import type { Reminder } from '../types/reminder';

const originalTimezone = process.env.TZ;
const cleanups: Array<() => void> = [];
const task = (dates: Partial<Reminder>): Reminder => ({ id: 'due', content: 'Task', completed: false, priority: 4, project: 'Inbox', ...dates });
beforeEach(() => {
	process.env.TZ = 'UTC'; resetLocalTimeZone();
	vi.useFakeTimers();
	vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
	vi.stubGlobal('document', new EventTarget());
});
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.useRealTimers(); vi.unstubAllGlobals();
	process.env.TZ = originalTimezone; resetLocalTimeZone();
});
function clock() {
	const clock = createReminderClock();
	cleanups.push(clock.subscribe(() => {}));
	return clock;
}

it('updates unchanged Today, Upcoming, header counts and relative labels at midnight', () => {
	vi.setSystemTime(new Date('2026-09-08T23:59:59Z'));
	const current = clock();
	const reminders = [task({ dueDate: '2026-09-09' })];
	const before = current.getSnapshot();
	expect(buildTodayViewModel(reminders, before.now).active).toEqual([]);
	expect(buildUpcomingViewModel(reminders, 7, before.now).upcomingReminders).toEqual(reminders);
	expect(formatDueDate('2026-09-09', 'en-US', before.now)).toBe('Tomorrow');
	vi.advanceTimersByTime(1001);
	const after = current.getSnapshot();
	expect(after).not.toBe(before);
	expect(buildTodayViewModel(reminders, after.now).active).toEqual(reminders);
	expect(buildUpcomingViewModel(reminders, 7, after.now).upcomingReminders).toEqual([]);
	expect(getRemindersHeaderData(reminders, ['Inbox'], 7, after.now).today.count).toBe(1);
	expect(formatDueDate('2026-09-09', 'en-US', after.now)).toBe('Today');
});

it('expires a timed deadline between minute ticks without waiting for a network response', () => {
	vi.setSystemTime(new Date('2026-09-08T12:00:10Z'));
	const current = clock();
	const reminder = task({ dueDatetime: '2026-09-08T12:00:20Z' });
	cleanups.push(current.track([reminder.dueDatetime]));
	expect(buildUpcomingViewModel([reminder], 7, current.getSnapshot().now).upcomingReminders).toHaveLength(1);
	vi.advanceTimersByTime(10_001);
	expect(buildUpcomingViewModel([reminder], 7, current.getSnapshot().now).upcomingReminders).toEqual([]);
	expect(isReminderOverdue(reminder, current.getSnapshot().now)).toBe(true);
	expect(getRemindersHeaderData([reminder], ['Inbox'], 7, current.getSnapshot().now).today.overdueCount).toBe(1);
	expect(vi.getTimerCount()).toBe(1);
});

it.each([
	['2026-03-29T00:00:00+01:00', '2026-03-30', 23],
	['2026-10-25T00:00:00+02:00', '2026-10-26', 25],
] as const)('advances from %s to %s after a %i-hour DST day', (start, tomorrow, hours) => {
	process.env.TZ = 'Europe/Berlin'; resetLocalTimeZone();
	vi.setSystemTime(new Date(start));
	const current = clock();
	const reminders = [task({ dueDate: tomorrow })];
	vi.advanceTimersByTime(hours * 60 * 60_000 - 1);
	expect(buildTodayViewModel(reminders, current.getSnapshot().now).active).toEqual([]);
	vi.advanceTimersByTime(2);
	expect(buildTodayViewModel(reminders, current.getSnapshot().now).active).toEqual(reminders);
});

it('rechecks timezone on focus and clears the calendar library timezone cache', () => {
	vi.setSystemTime(new Date('2026-09-09T01:00:00Z'));
	const current = clock();
	expect(getLocalTimeZone()).toBe('UTC');
	const reminders = [task({ dueDatetime: '2026-09-09T12:00:00Z' })];
	expect(buildTodayViewModel(reminders, current.getSnapshot().now).active).toHaveLength(1);
	process.env.TZ = 'America/Los_Angeles';
	window.dispatchEvent(new Event('focus'));
	expect(current.getSnapshot().timezone).toBe('America/Los_Angeles');
	expect(getLocalTimeZone()).toBe('America/Los_Angeles');
	expect(buildTodayViewModel(reminders, current.getSnapshot().now).active).toEqual([]);
});

it('catches clock jumps and prolonged suspension on resume, sharing and cleaning up its timer', () => {
	vi.setSystemTime(new Date('2026-09-08T12:00:00Z'));
	const current = clock();
	const stopPeer = current.subscribe(() => {});
	expect(vi.getTimerCount()).toBe(1);
	vi.setSystemTime(new Date('2026-09-18T17:00:00Z'));
	window.dispatchEvent(new Event('pageshow'));
	expect(current.getSnapshot().now.toISOString()).toBe('2026-09-18T17:00:00.000Z');
	vi.setSystemTime(new Date('2026-09-01T09:00:00Z'));
	document.dispatchEvent(new Event('visibilitychange'));
	expect(current.getSnapshot().now.toISOString()).toBe('2026-09-01T09:00:00.000Z');
	stopPeer();
	for (const cleanup of cleanups.splice(0)) cleanup();
	expect(vi.getTimerCount()).toBe(0);
	const stopped = current.getSnapshot();
	window.dispatchEvent(new Event('focus'));
	expect(current.getSnapshot()).toBe(stopped);
});
