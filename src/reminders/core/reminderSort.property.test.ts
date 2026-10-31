import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Reminder } from '../types/reminder';
import { isReminderDueToday, isReminderOverdue, parseReminderDateValue } from './dates/reminderDate';
import { selectTodayReminders, sortReminders } from './reminderSort';

const instant = fc.date({ min: new Date('2026-01-01T00:00:00Z'), max: new Date('2026-03-01T00:00:00Z'), noInvalidDate: true });
// Few distinct days and instants so equal keys, and therefore ties, are common.
const dateKey = fc.constantFrom('2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02');
const dueDatetime = fc.constantFrom('2026-01-31T08:00:00.000Z', '2026-01-31T23:30:00.000Z', '2026-02-01T12:00:00.000Z');
const reminder = fc.record({
	id: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'),
	completed: fc.boolean(),
	priority: fc.constantFrom(1 as const, 4 as const),
	due: fc.oneof(fc.constant({}), dateKey.map(dueDate => ({ dueDate })), dueDatetime.map(value => ({ dueDatetime: value }))),
}).map(({ id, completed, priority, due }): Reminder => ({ id, content: `Task ${id}`, completed, priority, ...due }));
const reminders = fc.array(reminder, { maxLength: 12 });

function sortKey(item: Reminder): [number, number, number] {
	const value = item.dueDatetime || item.dueDate;
	const time = value ? parseReminderDateValue(value)!.getTime() : Number.POSITIVE_INFINITY;
	return [item.completed ? 1 : 0, time, item.priority];
}

function compareKeys(a: number[], b: number[]): number {
	for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
	return 0;
}

describe('shared reminder ordering', () => {
	it('returns a permutation in non-decreasing order without changing its input', () => {
		fc.assert(fc.property(reminders, (items) => {
			const before = [...items];
			const sorted = sortReminders(items);
			expect(items).toEqual(before);
			expect([...sorted].sort((a, b) => before.indexOf(a) - before.indexOf(b))).toEqual(before);
			for (let index = 1; index < sorted.length; index++) {
				expect(compareKeys(sortKey(sorted[index - 1]!), sortKey(sorted[index]!))).toBeLessThanOrEqual(0);
			}
		}), { numRuns: 300 });
	});

	it('agrees on the order regardless of input order, and is idempotent', () => {
		fc.assert(fc.property(reminders.chain(items => fc.tuple(fc.constant(items), fc.shuffledSubarray(items, { minLength: items.length, maxLength: items.length }))),
			([items, shuffled]) => {
				const sorted = sortReminders(items);
				expect(sortReminders(shuffled).map(sortKey)).toEqual(sorted.map(sortKey));
				expect(sortReminders(sorted)).toEqual(sorted);
			}), { numRuns: 300 });
	});
});

describe('today selection', () => {
	it('lists each id once, only overdue or due today, and the last qualifying copy of each id', () => {
		fc.assert(fc.property(reminders, instant, fc.boolean(), (items, now, includeCompleted) => {
			const qualifies = (item: Reminder) => isReminderOverdue(item, now)
				|| (isReminderDueToday(item, now) && (includeCompleted || !item.completed));
			const selected = selectTodayReminders(items, now, includeCompleted);
			expect(new Set(selected.map(item => item.id)).size).toBe(selected.length);
			const expected = new Map<string, Reminder>();
			for (const item of items) if (qualifies(item)) expected.set(item.id, item);
			expect(new Map(selected.map(item => [item.id, item]))).toEqual(expected);
		}), { numRuns: 300 });
	});
});
