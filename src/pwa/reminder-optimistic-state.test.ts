import { describe, expect, it } from 'vitest';
import { applyReminderChanges, predictReminderCompletion, predictSavedReminder } from './reminder-optimistic-state';
import type { PendingReminderChange } from './reminder-outbox-types';
import type { ReminderRecord } from './types';

function reminder(id: string, overrides: Partial<ReminderRecord> = {}): ReminderRecord {
	return { id, content: id, priority: 4, completed: false, project: 'Inbox',
		filePath: 'Reminders/Inbox.md', revision: `revision-${id}`, ...overrides };
}

function change(kind: PendingReminderChange['kind'], recordId: string, overrides: Partial<PendingReminderChange> = {}): PendingReminderChange {
	return { operationId: crypto.randomUUID(), kind, recordId, status: 'pending', path: '/reminders/update',
		method: 'POST', body: '{}', attempts: 0, retryAt: 0, ...overrides };
}

describe('optimistic reminder projection', () => {
	it('restores a failed deletion without undoing another pending edit or newer confirmed data', () => {
		const original = reminder('one');
		const other = reminder('two');
		const deletion = change('delete', original.id, { previous: original });
		const edit = change('save', other.id, { optimistic: { ...other, content: 'Edited immediately' } });
		expect(applyReminderChanges([original, other], ['Inbox'], [deletion, edit]).visibleReminders)
			.toEqual([{ ...other, content: 'Edited immediately' }]);
		const latest = { ...original, description: 'Synced while delete was pending' };
		const restored = applyReminderChanges([latest, other], ['Inbox'], [{ ...deletion, status: 'failed' }, edit]);
		expect(restored.visibleReminders).toEqual([latest, { ...other, content: 'Edited immediately' }]);
	});

	it('keeps a rejected save visible with its draft and newly created project', () => {
		const optimistic = reminder('new', { content: 'Preserve my work', description: 'Notes', project: 'Work', filePath: 'Reminders/Work.md' });
		const result = applyReminderChanges([], ['Inbox'], [change('save', 'new', { status: 'failed', optimistic })]);
		expect(result.visibleReminders).toEqual([optimistic]);
		expect(result.visibleProjects).toEqual(['Inbox', 'Work']);
	});

	it('rolls back only the rejected completion and does not mutate confirmed input', () => {
		const one = reminder('one');
		const two = reminder('two');
		const records = [one, two];
		const result = applyReminderChanges(records, ['Inbox'], [
			change('complete', 'one', { status: 'failed', optimistic: { ...one, completed: true } }),
			change('complete', 'two', { optimistic: { ...two, completed: true } }),
		]);
		expect(result.visibleReminders.map(record => record.completed)).toEqual([false, true]);
		expect(records.map(record => record.completed)).toEqual([false, false]);
	});

	it('advances a recurring occurrence immediately without marking the next occurrence complete', () => {
		const original = reminder('daily', { dueDate: '2099-01-01', dueDatetime: '2099-01-01T09:00:00.000Z',
			recurrence: { frequency: 'daily', timezone: 'UTC', hour: 9, minute: 0, completedCount: 1 } });
		const predicted = predictReminderCompletion(original, true);
		expect(predicted).toMatchObject({ completed: false, dueDatetime: '2099-01-02T09:00:00.000Z',
			recurrence: { completedCount: 2, timezone: 'UTC' } });
		expect(original.recurrence?.completedCount).toBe(1);
	});

	it('marks the final recurring occurrence complete', () => {
		const original = reminder('daily', { dueDate: '2099-01-01',
			recurrence: { frequency: 'daily', timezone: 'UTC', count: 2, completedCount: 1 } });
		expect(predictReminderCompletion(original, true)).toMatchObject({ completed: true, dueDate: '2099-01-01',
			recurrence: { completedCount: 2 } });
	});

	it('predicts a created reminder with a stable identity and project path', () => {
		expect(predictSavedReminder('stable-id', { folderPath: 'Reminders', content: 'New reminder', description: 'Notes',
			project: 'Work/Planning', priority: 1, dueDate: '2099-01-02', dueDatetime: null })).toEqual({
			id: 'stable-id', content: 'New reminder', description: 'Notes', project: 'Work/Planning', priority: 1,
			completed: false, dueDate: '2099-01-02', dueDatetime: undefined, recurrence: undefined,
			filePath: 'Reminders/Work/Planning.md',
		});
	});
});
