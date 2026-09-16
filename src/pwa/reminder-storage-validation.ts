import * as v from 'valibot';
import { validateRecurrence } from '@/reminders/core/validateRecurrence';
import type { RecurrenceRule } from '@/reminders/types/reminder';
import type { ModalDraft, ModalPickerId, ReminderRecord } from './types';

function isStoredCalendarDate(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
		&& new Date(value).toISOString().slice(0, 10) === value;
}

const prioritySchema = v.picklist([1, 4]);
// Validate existing metadata without normalizing or replacing the stored value.
const recurrenceSchema = v.optional(v.custom<RecurrenceRule>(value => !('error' in validateRecurrence(value))));
const optionalString = v.optional(v.string());

/** Stored objects can carry unknown fields, but must never be arrays. */
export function storedObject<T extends v.ObjectEntries>(entries: T) {
	const schema = v.object(entries);
	return v.pipe(v.custom<v.InferInput<typeof schema>>(value => value !== null && typeof value === 'object' && !Array.isArray(value)), schema);
}

/** Preserve legacy String(value) checks without coercing or rewriting saved data. */
export function storedStringChoice<T extends string>(choices: readonly T[]) {
	return v.custom<T>(value => choices.includes(String(value) as T));
}

export const reminderRecordSchema = v.object({
	id: v.pipe(v.string(), v.check(value => value.length > 0)),
	content: v.string(),
	project: v.string(),
	completed: v.boolean(),
	priority: prioritySchema,
	filePath: v.pipe(v.string(), v.check(value => value.toLowerCase().endsWith('.md') && !value.includes('\\')
		&& !Array.from(value).some(char => char.charCodeAt(0) < 32)
		&& !value.split('/').some(part => !part || part === '.' || part === '..'))),
	description: optionalString,
	revision: optionalString,
	lineNumber: v.optional(v.pipe(v.number(), v.check(value => Number.isSafeInteger(value) && value >= 0))),
	dueDate: v.optional(v.pipe(v.string(), v.check(isStoredCalendarDate))),
	dueDatetime: v.optional(v.pipe(v.string(), v.check(value =>
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
		&& isStoredCalendarDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value))))),
	recurrence: recurrenceSchema,
});

export const reminderDraftSchema = v.object({
	content: v.string(),
	description: v.string(),
	project: v.string(),
	defaultProject: v.string(),
	dueDate: v.string(),
	dueTime: v.string(),
	priority: prioritySchema,
	// Retain the existing acceptance rule for drafts already saved on devices.
	activePicker: v.custom<ModalPickerId | null>(value => value === null || ['date', 'project', 'recurrence'].includes(String(value))), // eslint-disable-line @typescript-eslint/no-base-to-string -- Preserve the legacy stored-draft acceptance rule.
	deleteConfirm: v.boolean(),
	originalDueDatetime: optionalString,
	recurrence: recurrenceSchema,
});

/** Check only: preserve unknown fields and original objects in cache/outbox/drafts. */
export function isStoredReminderRecord(value: unknown, folderPath: string): value is ReminderRecord {
	return !Array.isArray(value) && v.is(reminderRecordSchema, value) && value.filePath.startsWith(`${folderPath}/`);
}

export function isStoredReminderDraft(value: unknown): value is ModalDraft {
	return !Array.isArray(value) && v.is(reminderDraftSchema, value);
}
