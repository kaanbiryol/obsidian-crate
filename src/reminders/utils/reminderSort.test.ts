import { describe, expect, it } from 'vitest';
import type { Reminder } from '../types/reminder';
import { sortReminders, sortRemindersByFileOrder } from './reminderSort';

const reminder = (id: string, fields: Partial<Reminder> = {}): Reminder => ({ id, content: id, priority: 4, completed: false, ...fields });
const ids = (reminders: Reminder[]) => reminders.map(item => item.id);

describe('sortReminders', () => {
	it('orders open before completed, then by due time with undated last, then by priority', () => {
		const sorted = sortReminders([
			reminder('done', { completed: true, dueDate: '2026-01-01' }),
			reminder('undated-high', { priority: 1 }),
			reminder('later', { dueDatetime: '2026-01-02T10:00:00Z' }),
			reminder('earlier-low', { dueDatetime: '2026-01-02T09:00:00Z' }),
			reminder('earlier-high', { dueDatetime: '2026-01-02T09:00:00Z', priority: 1 }),
			reminder('undated-low'),
		]);
		expect(ids(sorted)).toEqual(['earlier-high', 'earlier-low', 'later', 'undated-high', 'undated-low', 'done']);
	});

	it('does not mutate its input', () => {
		const input = [reminder('b', { dueDate: '2026-01-02' }), reminder('a', { dueDate: '2026-01-01' })];
		sortReminders(input);
		expect(ids(input)).toEqual(['b', 'a']);
	});
});

describe('sortRemindersByFileOrder', () => {
	it('keeps open reminders first and orders by source line', () => {
		expect(ids(sortRemindersByFileOrder([
			reminder('done', { completed: true, lineNumber: 0 }),
			reminder('third', { lineNumber: 4 }),
			reminder('unplaced'),
			reminder('first', { lineNumber: 1 }),
		]))).toEqual(['first', 'third', 'unplaced', 'done']);
	});
});
