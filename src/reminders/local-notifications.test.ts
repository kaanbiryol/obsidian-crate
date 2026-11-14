import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_CHECK_DELAY_MS, startLocalReminderNotifications, type LocalNotification, type LocalNotificationHost } from './local-notifications';
import { desktopNotificationsActive } from './runtime';
import { notificationDatetime } from './core/notification-time';
import type { IndexedReminder } from './data/reminder-index';

const START = Date.parse('2026-11-15T10:00:00.000Z');
const MINUTE = 60_000;

function reminder(id: string, dueDatetime?: string, extra: Partial<IndexedReminder> = {}): IndexedReminder {
	return { id, content: `Task ${id}`, dueDatetime, priority: 4, completed: false, project: 'Inbox', filePath: 'Reminders/Inbox.md', lineNumber: 0, rawLine: '', ...extra };
}

function at(offsetMs: number): string {
	return new Date(START + offsetMs).toISOString();
}

function harness(initial: IndexedReminder[] | null, lastChecked: number | null = START) {
	let reminders = initial;
	let last = lastChecked;
	let active = true;
	const shown: LocalNotification[] = [];
	const host: LocalNotificationHost = {
		reminders: () => reminders,
		schedule: () => ({ allDayTime: '09:00', timezone: 'UTC' }),
		isActive: () => active,
		show: notification => shown.push(notification),
		loadLastChecked: () => last,
		saveLastChecked: value => { last = value; },
		now: () => Date.now(),
	};
	const controller = new AbortController();
	return {
		shown, controller,
		start: () => startLocalReminderNotifications(host, controller.signal),
		setReminders: (next: IndexedReminder[] | null) => { reminders = next; },
		setActive: (value: boolean) => { active = value; },
		lastChecked: () => last,
	};
}

describe('local reminder notifications', () => {
	beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); vi.stubGlobal('window', globalThis); });
	afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

	it('notifies a reminder when it falls due, once', () => {
		const h = harness([reminder('a', at(10 * MINUTE))]);
		h.start();
		vi.advanceTimersByTime(10 * MINUTE - 1);
		expect(h.shown).toEqual([]);
		vi.advanceTimersByTime(1);
		expect(h.shown).toEqual([{ title: 'Task a', body: 'Inbox', tag: 'a' }]);
		vi.advanceTimersByTime(60 * MINUTE);
		expect(h.shown).toHaveLength(1);
	});

	it('notifies reminders that fell due since the last check, within a day', () => {
		const h = harness([
			reminder('missed', at(-30 * MINUTE)),
			reminder('stale', at(-25 * 60 * MINUTE)),
		], START - 26 * 60 * MINUTE);
		h.start();
		expect(h.shown.map(n => n.tag)).toEqual(['missed']);
	});

	it('does not notify a reminder already past due when the device first saw it', () => {
		const h = harness([reminder('old', at(-5 * MINUTE))], null);
		h.start();
		expect(h.shown).toEqual([]);
		expect(h.lastChecked()).toBe(START);
	});

	it('does not replay reminders due while turned off once turned on again', () => {
		const h = harness([reminder('a', at(MINUTE))]);
		h.setActive(false);
		h.start();
		vi.advanceTimersByTime(2 * MINUTE);
		h.setActive(true);
		vi.advanceTimersByTime(MAX_CHECK_DELAY_MS);
		expect(h.shown).toEqual([]);
	});

	it('waits for the folder to load before checking', () => {
		const h = harness(null, START - 10 * MINUTE);
		const notifications = h.start();
		expect(h.lastChecked()).toBe(START - 10 * MINUTE);
		h.setReminders([reminder('missed', at(-MINUTE))]);
		notifications.refresh();
		expect(h.shown.map(n => n.tag)).toEqual(['missed']);
	});

	it('follows index changes: a snoozed reminder notifies at its new time', () => {
		const h = harness([reminder('a', at(5 * MINUTE))]);
		const notifications = h.start();
		h.setReminders([reminder('a', at(20 * MINUTE))]);
		notifications.refresh();
		vi.advanceTimersByTime(10 * MINUTE);
		expect(h.shown).toEqual([]);
		vi.advanceTimersByTime(10 * MINUTE);
		expect(h.shown.map(n => n.tag)).toEqual(['a']);
	});

	it('summarizes more than three reminders due together', () => {
		const h = harness(['a', 'b', 'c', 'd'].map(id => reminder(id, at(MINUTE))));
		h.start();
		vi.advanceTimersByTime(MINUTE);
		expect(h.shown).toEqual([{ title: '4 reminders are due', body: 'Task a, Task b, Task c…', tag: 'crate-reminders-summary' }]);
	});

	it('uses the all-day time for reminders without a time', () => {
		vi.setSystemTime(Date.parse('2026-11-15T08:00:00.000Z'));
		const h = harness([reminder('day', undefined, { dueDate: '2026-11-15' })], Date.now());
		h.start();
		vi.advanceTimersByTime(60 * MINUTE);
		expect(h.shown.map(n => n.tag)).toEqual(['day']);
	});

	it('stops when its backend stops', () => {
		const h = harness([reminder('a', at(MINUTE))]);
		h.start();
		h.controller.abort();
		vi.advanceTimersByTime(2 * MINUTE);
		expect(h.shown).toEqual([]);
	});
});

describe('desktopNotificationsActive', () => {
	const plugin = (desktopNotifications: boolean) =>
		({ remindersSettings: { desktopNotifications } }) as Parameters<typeof desktopNotificationsActive>[0];

	it('follows the toggle on desktop', () => {
		expect(desktopNotificationsActive(plugin(true))).toBe(true);
		expect(desktopNotificationsActive(plugin(false))).toBe(false);
	});
});

describe('notificationDatetime', () => {
	it('matches the Worker rule for timed and all-day reminders', () => {
		const schedule = { allDayTime: '09:00', timezone: 'America/New_York' };
		expect(notificationDatetime({ dueDatetime: '2026-11-15T10:00:00.000Z', dueDate: '2026-11-15' }, schedule)).toBe('2026-11-15T10:00:00.000Z');
		expect(notificationDatetime({ dueDate: '2026-11-15' }, schedule)).toBe('2026-11-15T14:00:00.000Z');
		expect(notificationDatetime({ dueDate: '2026-11-15' }, { ...schedule, allDayTime: null })).toBeUndefined();
		expect(notificationDatetime({}, schedule)).toBeUndefined();
	});
});
