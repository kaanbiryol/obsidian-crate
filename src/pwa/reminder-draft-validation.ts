import * as v from 'valibot';
import { validateRecurrence } from '@/reminders/core/validateRecurrence';
import { isStoredReminderDraft, storedObject, storedStringChoice } from './reminder-storage-validation';
import type { ModalState } from './types';

const optionalString = v.optional(v.string());
const nullableString = v.nullable(v.string());
const nonEmptyString = v.pipe(v.string(), v.check(value => value.length > 0));
const modalSchema = storedObject({
	mode: storedStringChoice(['create', 'edit']),
	draft: v.custom(isStoredReminderDraft),
	reminderId: optionalString,
	operationId: optionalString,
	expectedRevision: optionalString,
	recovery: v.optional(v.boolean()),
	filePath: optionalString,
	pendingSave: v.optional(storedObject({
		path: storedStringChoice(['/reminders/create', '/reminders/update']),
		body: v.string(),
		draftKey: v.string(),
		input: storedObject({
			folderPath: v.string(), content: v.string(), project: v.string(), priority: v.picklist([1, 4]),
			description: nullableString, dueDate: nullableString, dueDatetime: nullableString,
			recurrence: v.nullish(v.custom(value => !('error' in validateRecurrence(value)))),
		}),
	})),
});
const bodySchema = storedObject({ id: nonEmptyString, operationId: nonEmptyString, folderPath: v.string(), filePath: optionalString });

function filePath(value: string | undefined, folderPath: string): boolean {
	return value === undefined || value.startsWith(`${folderPath}/`)
		&& value.endsWith('.md') && !value.includes('\\')
		&& !value.split('/').some(part => !part || part === '.' || part === '..');
}

/** Validate retained attempts without rewriting their body or operation identity. */
export function isStoredReminderModal(value: unknown, folderPath: string): value is ModalState {
	if (!v.is(modalSchema, value) || !filePath(value.filePath, folderPath)) return false;
	if (value.pendingSave === undefined) return true;
	if (value.pendingSave.input.folderPath !== folderPath) return false;
	try {
		const body: unknown = JSON.parse(value.pendingSave.body);
		return v.is(bodySchema, body) && body.folderPath === folderPath && filePath(body.filePath, folderPath);
	} catch { return false; }
}
