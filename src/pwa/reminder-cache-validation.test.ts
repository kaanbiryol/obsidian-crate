import { describe, expect, it } from 'vitest';
import { normalizeSnapshot } from './reminder-cache-validation';

const reminder = { id: 'r1', content: 'Task', completed: false, priority: 4, project: 'Inbox', filePath: 'Reminders/Inbox.md' };
const snapshot = { folderPath: 'Reminders', reminders: [reminder], projects: ['Inbox'], savedAt: 100, etag: 'revision', issues: [] };

describe('durable reminder snapshot validation', () => {
	it.each([
		null, {}, { ...reminder, id: '' }, { ...reminder, priority: 2 }, { ...reminder, content: [] },
		{ ...reminder, filePath: 'Reminders/../Private.md' }, { ...reminder, filePath: 'Private/Inbox.md' },
		{ ...reminder, dueDate: '2099-02-29' }, { ...reminder, dueDatetime: '2099-01-01T10:00:00' },
		{ ...reminder, dueDatetime: '2099-02-30T10:00:00Z' }, { ...reminder, description: {} },
		{ ...reminder, recurrence: { frequency: 'daily', completedCount: -1 } },
		{ ...reminder, recurrence: { frequency: 'weekly', timezone: 'Invalid/Timezone' } },
	])('rejects a damaged item and its whole-list ETag (%j)', damaged => {
		expect(normalizeSnapshot({ ...snapshot, reminders: [reminder, damaged] }, 'Reminders')).toBeNull();
	});
	it.each([
		{ savedAt: NaN }, { savedAt: -1 }, { projects: ['Inbox', null] }, { reminders: [reminder, reminder] },
		{ issues: undefined }, { issues: [{ path: '', reason: 'bad' }] }, { folderPath: 'Other' },
	])('rejects incomplete or damaged envelope metadata (%j)', patch => {
		expect(normalizeSnapshot({ ...snapshot, ...patch }, 'Reminders')).toBeNull();
	});
	it('preserves supported instants, recurrence and incomplete-source notices', () => {
		const complete = { ...snapshot, reminders: [{ ...reminder, dueDate: '2099-03-01', dueDatetime: '2099-03-01T09:00:37.123Z',
			recurrence: { frequency: 'daily', timezone: 'Europe/Berlin', completedCount: 3 } }], issues: [{ path: 'Reminders/Large.md', reason: 'Too large' }] };
		expect(normalizeSnapshot(complete, 'Reminders')).toEqual(complete);
	});
});
