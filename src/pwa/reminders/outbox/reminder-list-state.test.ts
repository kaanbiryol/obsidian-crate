import { expect, it } from 'vitest';
import { applyReminderListEffect, applyReminderListEffects, reorderProjectReminders, toSharedReminder, type ReminderListEffect } from './reminder-list-state';
import type { ReminderRecord } from '../types';
import { timezone } from '@/reminders/core/dates/time';

it('reuses card data for an unchanged reminder record', () => {
	const record = { id: 'one', content: 'One', completed: false, priority: 4, revision: 'r1', filePath: 'Reminders/Inbox.md', project: '' } as ReminderRecord;
	const shared = toSharedReminder(record);
	expect(shared).toMatchObject({ id: 'one', project: 'Inbox' });
	expect(toSharedReminder(record)).toBe(shared);
	expect(toSharedReminder({ ...record, content: 'Changed' })).not.toBe(shared);
});

it('gives a recurrence without a time zone the local one, like the plugin', () => {
	const record = { id: 'one', content: 'One', completed: false, priority: 4, filePath: 'Reminders/Inbox.md', project: 'Inbox', recurrence: { frequency: 'daily' } } as ReminderRecord;
	expect(toSharedReminder(record).recurrence).toEqual({ frequency: 'daily', timezone: timezone() });
});

it('keeps unmoved records when reordering a project', () => {
	const record = (id: string, lineNumber: number) => ({ id, content: id, completed: false, priority: 4, revision: 'r1', filePath: 'Reminders/Inbox.md', project: 'Inbox', lineNumber }) as ReminderRecord;
	const reminders = [record('a', 1), record('b', 2), record('c', 3), record('d', 4)];
	const reordered = reorderProjectReminders(reminders, 'Inbox', ['b', 'a', 'c', 'd']);
	expect(reordered.map(item => [item.id, item.lineNumber])).toEqual([['b', 1], ['a', 2], ['c', 3], ['d', 4]]);
	expect(reordered[2]).toBe(reminders[2]);
	expect(reordered[3]).toBe(reminders[3]);
	expect(reorderProjectReminders(reminders, 'Inbox', ['a', 'b', 'c', 'd']).every((item, index) => item === reminders[index])).toBe(true);
});

it('applies upsert, delete and reorder effects without mutating the list', () => {
	const record = (id: string, project = 'Inbox', lineNumber = 0): ReminderRecord => ({ id, content: id, priority: 4, completed: false, project, filePath: `Reminders/${project}.md`, lineNumber });
	const list = { reminders: [record('a', 'Inbox', 1), record('b', 'Inbox', 2)], projects: ['Inbox'] };
	const upserted = applyReminderListEffect(list, { kind: 'upsert', record: record('c', 'Work') });
	expect(upserted.reminders.map(item => item.id)).toEqual(['a', 'b', 'c']);
	expect(upserted.projects).toEqual(['Inbox', 'Work']);
	expect(applyReminderListEffect(list, { kind: 'delete', recordId: 'a' }).reminders.map(item => item.id)).toEqual(['b']);
	expect(applyReminderListEffect(list, { kind: 'reorder', project: 'Inbox', orderedIds: ['b', 'a'] }).reminders.map(item => item.id)).toEqual(['b', 'a']);
	expect(list.reminders.map(item => item.id)).toEqual(['a', 'b']);
});

it('applies a batch of effects exactly like applying them one at a time', () => {
	const record = (id: string, project = 'Inbox', lineNumber = 0, content = id): ReminderRecord => ({ id, content, priority: 4, completed: false, project, filePath: `Reminders/${project}.md`, lineNumber });
	const list = { reminders: [record('a', 'Inbox', 1), record('b', 'Inbox', 2), record('c', 'Inbox', 3)], projects: ['Inbox'] };
	const effects: ReminderListEffect[] = [
		{ kind: 'upsert', record: record('b', 'Inbox', 2, 'edited') },
		{ kind: 'delete', recordId: 'a' },
		{ kind: 'upsert', record: record('d', 'Work') },
		{ kind: 'reorder', project: 'Inbox', orderedIds: ['c', 'b'] },
		{ kind: 'upsert', record: record('a', 'Inbox', 1, 'restored') },
		{ kind: 'delete', recordId: 'missing' },
		{ kind: 'delete', recordId: 'd' },
		{ kind: 'upsert', record: record('d', 'Work', 0, 'again') },
	];
	const folded = effects.reduce(applyReminderListEffect, list);
	expect(applyReminderListEffects(list, effects)).toEqual(folded);
	expect(list.reminders.map(item => item.id)).toEqual(['a', 'b', 'c']);
	// No effects keeps the confirmed arrays, so memoized views see no change.
	// Every copy of a duplicated ID changes, as one effect at a time would change it.
	const doubled = { reminders: [record('x'), record('y'), record('x')], projects: ['Inbox'] };
	const twice: ReminderListEffect[] = [{ kind: 'upsert', record: record('x', 'Inbox', 0, 'edited') }, { kind: 'delete', recordId: 'y' }];
	expect(applyReminderListEffects(doubled, twice)).toEqual(twice.reduce(applyReminderListEffect, doubled));
	expect(applyReminderListEffects(doubled, [{ kind: 'delete', recordId: 'x' }]).reminders.map(item => item.id)).toEqual(['y']);
	const unchanged = applyReminderListEffects(list, []);
	expect(unchanged.reminders).toBe(list.reminders);
	expect(unchanged.projects).toBe(list.projects);
});
