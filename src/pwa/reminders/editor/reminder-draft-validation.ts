import * as v from 'valibot';
import { isStoredReminderDraft, storedObject, storedStringChoice } from '../cache/reminder-storage-validation';
import type { ModalState } from '../types';
import { isSyncPath } from '../../../protocol/sync-validation';

const optionalString = v.optional(v.string());
const modalSchema = storedObject({
	mode: storedStringChoice(['create', 'edit']),
	draft: v.custom(isStoredReminderDraft),
	reminderId: optionalString,
	operationId: optionalString,
	expectedRevision: optionalString,
	recovery: v.optional(v.boolean()),
	filePath: optionalString,
	pendingSave: v.optional(v.never()),
});

function filePath(value: string | undefined, folderPath: string): boolean {
	return value === undefined || value.startsWith(`${folderPath}/`)
		&& value.toLowerCase().endsWith('.md') && isSyncPath(value);
}

/** Validate drafts without rewriting saved data. */
export function isStoredReminderModal(value: unknown, folderPath: string): value is ModalState {
	return v.is(modalSchema, value) && filePath(value.filePath, folderPath);
}
