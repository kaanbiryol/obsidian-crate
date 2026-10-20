import { expect, it } from 'vitest';
import { reorderProjectReminders, toSharedReminder } from './reminder-list-state';
import type { ReminderRecord } from '../../types';

it('reuses card data for an unchanged reminder record', () => {
	const record = { id: 'one', content: 'One', completed: false, priority: 4, revision: 'r1', filePath: 'Reminders/Inbox.md', project: '' } as ReminderRecord;
	const shared = toSharedReminder(record);
	expect(shared).toMatchObject({ id: 'one', project: 'Inbox', fileLink: 'Reminders/Inbox.md' });
	expect(toSharedReminder(record)).toBe(shared);
	expect(toSharedReminder({ ...record, content: 'Changed' })).not.toBe(shared);
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
