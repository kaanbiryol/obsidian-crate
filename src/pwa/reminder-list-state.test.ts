import { expect, it } from 'vitest';
import { toSharedReminder } from './reminder-list-state';
import type { ReminderRecord } from './types';

it('reuses card data for an unchanged reminder record', () => {
	const record = { id: 'one', content: 'One', completed: false, priority: 4, revision: 'r1', filePath: 'Reminders/Inbox.md', project: '' } as ReminderRecord;
	const shared = toSharedReminder(record);
	expect(shared).toMatchObject({ id: 'one', project: 'Inbox', fileLink: 'Reminders/Inbox.md' });
	expect(toSharedReminder(record)).toBe(shared);
	expect(toSharedReminder({ ...record, content: 'Changed' })).not.toBe(shared);
});
