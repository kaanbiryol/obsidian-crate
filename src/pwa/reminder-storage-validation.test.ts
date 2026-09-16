import { describe, expect, it } from 'vitest';
import { isStoredReminderDraft, isStoredReminderRecord } from './reminder-storage-validation';

const record = { id: 'one', content: 'Task', project: 'Inbox', completed: false, priority: 4, filePath: 'Reminders/Inbox.md' };
const draft = { content: '', description: '', project: 'Inbox', defaultProject: 'Inbox', dueDate: '', dueTime: '',
	priority: 4, activePicker: null, deleteConfirm: false };

describe('stored reminder schema compatibility', () => {
	it('checks without stripping unknown fields or normalizing recurrence metadata', () => {
		const recurrence = { frequency: 'weekly', daysOfWeek: [5, 1, 5], futureMetadata: { keep: true } };
		for (const [value, validate] of [
			[{ ...record, recurrence, futureField: 'keep', description: undefined }, (input: unknown) => isStoredReminderRecord(input, 'Reminders')],
			[{ ...draft, recurrence, futureField: 'keep', originalDueDatetime: undefined }, isStoredReminderDraft],
		] as const) {
			const before = structuredClone(value);
			expect(validate(value)).toBe(true);
			expect(value).toEqual(before);
			expect(value.recurrence).toBe(recurrence);
		}
	});

	it.each([
		{ filePath: 'RemindersOther/Inbox.md' }, { filePath: 'Reminders//Inbox.md' },
		{ filePath: 'Reminders/./Inbox.md' }, { filePath: 'Reminders/../Inbox.md' },
		{ filePath: 'Reminders/Inbox\u0000.md' }, { filePath: 'Reminders/Inbox\\note.md' },
		{ lineNumber: -1 }, { lineNumber: 0.5 }, { lineNumber: Number.MAX_SAFE_INTEGER + 1 },
		{ dueDate: '2025-02-29' }, { dueDatetime: '2024-02-29T12:00' }, { dueDate: null },
		{ description: null }, { recurrence: null }, { priority: '4' },
	])('rejects damaged or out-of-scope records (%j)', patch => {
		expect(isStoredReminderRecord({ ...record, ...patch }, 'Reminders')).toBe(false);
	});

	it('accepts leap days, explicit-offset instants, and uppercase Markdown extensions', () => {
		expect(isStoredReminderRecord({ ...record, filePath: 'Reminders/Sub/Inbox.MD', lineNumber: 0,
			dueDate: '2024-02-29', dueDatetime: '2024-02-29T12:00:37.123+02:00' }, 'Reminders')).toBe(true);
	});

	it.each([{ content: null }, { deleteConfirm: 'false' }, { dueTime: 12 }, { activePicker: 'unknown' },
		{ originalDueDatetime: null }, { recurrence: { frequency: 'daily', interval: 0 } }])('rejects damaged drafts (%j)', patch => {
		expect(isStoredReminderDraft({ ...draft, ...patch })).toBe(false);
	});

	it('retains the previous picker acceptance rule for already stored drafts', () => {
		expect(isStoredReminderDraft({ ...draft, activePicker: ['date'] })).toBe(true);
	});

	it('rejects arrays even when they carry otherwise valid object fields', () => {
		expect(isStoredReminderRecord(Object.assign([], record), 'Reminders')).toBe(false);
		expect(isStoredReminderDraft(Object.assign([], draft))).toBe(false);
	});
});
