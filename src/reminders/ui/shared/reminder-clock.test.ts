import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getLocalTimeZone, resetLocalTimeZone } from '@internationalized/date';
import { createReminderClock } from './reminder-clock';
import { buildTodayViewModel, buildUpcomingViewModel } from '../views/viewModels';
import { getRemindersHeaderData } from './remindersViewModel';
import { formatDueDate } from '../format/dateFormatting';
import { isReminderOverdue } from '../../core/dates/reminderDate';
import type { Reminder } from '../../types/reminder';

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
	expect(formatDueDate(reminders[0]!.dueDatetime, 'en-US', current.getSnapshot().now)).toBe('Today, 12:00');
	process.env.TZ = 'America/Los_Angeles';
	window.dispatchEvent(new Event('focus'));
	expect(current.getSnapshot().timezone).toBe('America/Los_Angeles');
	expect(formatDueDate(reminders[0]!.dueDatetime, 'en-US', current.getSnapshot().now)).toBe('Tomorrow, 05:00');
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

it('tracks thousands of card deadlines in linear time and reschedules after early removals', () => {
	vi.setSystemTime(new Date('2026-09-08T12:00:00Z'));
	const current = clock();
	const count = 20_000;
	const started = performance.now();
	// Descending deadlines move the timer earlier on every card.
	const stops = Array.from({ length: count }, (_, i) => current.track([new Date(Date.parse('2026-09-08T12:00:30Z') + (count - i) * 1000).toISOString()]));
	for (const stop of stops.slice(1)) stop();
	cleanups.push(stops[0]!);
	// Before: about 1.3 seconds to mount and 1.5 seconds to unmount 20,000 cards on an M-series Mac.
	expect(performance.now() - started).toBeLessThan(1_000);
	expect(vi.getTimerCount()).toBe(1);
	// The removed 12:00:31 deadline causes one early wake-up, then the
	// remaining far deadline leaves the next wake-up at the minute boundary.
	// Neither publishes a snapshot because nothing observable changed.
	const before = current.getSnapshot();
	const setTimer = vi.spyOn(window, 'setTimeout');
	vi.advanceTimersByTime(31_001);
	expect(setTimer).toHaveBeenLastCalledWith(expect.any(Function), 28_999);
	vi.advanceTimersByTime(28_999);
	expect(setTimer).toHaveBeenLastCalledWith(expect.any(Function), 60_000);
	expect(current.getSnapshot()).toBe(before);
	expect(vi.getTimerCount()).toBe(1);
});

it('keeps the snapshot on minute ticks and resume events until something observable changes', () => {
	vi.setSystemTime(new Date('2026-09-08T12:00:10Z'));
	const current = createReminderClock();
	const listener = vi.fn();
	cleanups.push(current.subscribe(listener));
	const before = current.getSnapshot();
	listener.mockClear();
	vi.advanceTimersByTime(10 * 60_000);
	window.dispatchEvent(new Event('focus'));
	window.dispatchEvent(new Event('pageshow'));
	document.dispatchEvent(new Event('visibilitychange'));
	expect(current.getSnapshot()).toBe(before);
	expect(listener).not.toHaveBeenCalled();

	// A deadline already passed since the published time refreshes on track.
	const reminder = task({ dueDatetime: '2026-09-08T12:05:00Z' });
	expect(isReminderOverdue(reminder, before.now)).toBe(false);
	cleanups.push(current.track([reminder.dueDatetime]));
	expect(listener).toHaveBeenCalledTimes(1);
	expect(isReminderOverdue(reminder, current.getSnapshot().now)).toBe(true);

	// Moving the clock back across a tracked deadline on the same day refreshes too.
	const afterTrack = current.getSnapshot();
	vi.setSystemTime(new Date('2026-09-08T12:04:00Z'));
	window.dispatchEvent(new Event('focus'));
	expect(current.getSnapshot()).not.toBe(afterTrack);
	expect(isReminderOverdue(reminder, current.getSnapshot().now)).toBe(false);
});
