import { discardReminderDraft, saveReminderDraft } from './reminder-drafts';
import type { ApiFetch, ModalState, ReminderMutationBody, ReminderRecord } from './types';

interface SaveResult { reminder: ReminderRecord; notificationWarning?: string; differentRequest?: boolean }
class RejectedSave extends Error {}

function draftKey({ draft }: ModalState): string {
	const { activePicker: _picker, deleteConfirm: _confirm, ...input } = draft;
	return JSON.stringify(input);
}

async function submit(apiFetch: ApiFetch, pending: NonNullable<ModalState['pendingSave']>): Promise<SaveResult> {
	const response = await apiFetch(pending.path, { method: 'POST', body: pending.body });
	if (!response.ok) {
		const text = await response.text();
		let error: { code?: string; error?: string; committedReminder?: ReminderRecord } = {};
		try { error = JSON.parse(text) as typeof error; } catch { /* A proxy may return plain text. */ }
		if (response.status === 409 && error.code === 'operation_mismatch' && error.committedReminder) {
			return { reminder: error.committedReminder, differentRequest: true };
		}
		// A definite rejection did not commit. Let corrected input retry with the
		// same operation/create identity; ambiguous transport failures stay pinned.
		if ([400, 403, 404, 409, 413, 428].includes(response.status) && error.code !== 'operation_mismatch') throw new RejectedSave(error.error ?? text);
		throw new Error(error.error ?? text);
	}
	const result = await response.json() as SaveResult;
	if (!result.reminder) throw new Error('The server did not confirm this reminder. Retry to check the earlier save.');
	return result;
}

function prepare(modal: ModalState, input: ReminderMutationBody): NonNullable<ModalState['pendingSave']> {
	modal.operationId ??= crypto.randomUUID();
	modal.pendingSave = {
		path: modal.mode === 'edit' ? '/reminders/update' : '/reminders/create',
		body: JSON.stringify({ ...input, id: modal.reminderId ?? modal.operationId, operationId: modal.operationId,
			filePath: modal.filePath, expectedRevision: modal.expectedRevision }),
		input,
		draftKey: draftKey(modal),
	};
	saveReminderDraft(modal);
	return modal.pendingSave;
}

/** Keep an immutable attempted command separate from the still-editable draft. */
export async function saveReminderCommand(modal: ModalState, input: ReminderMutationBody, apiFetch: ApiFetch, sessionCurrent: () => boolean): Promise<SaveResult> {
	try {
		const pending = modal.pendingSave ?? prepare(modal, input);
		const result = await submit(apiFetch, pending);
		if (!sessionCurrent() || !result.differentRequest && pending.draftKey === draftKey(modal)) return result;

		// Acknowledge the original before expressing later edits as a new command.
		// A stale receipt base still conflicts with intervening third-party edits.
		discardReminderDraft(modal);
		modal.mode = 'edit';
		modal.reminderId = result.reminder.id;
		modal.filePath = result.reminder.filePath;
		modal.expectedRevision = result.reminder.revision;
		modal.operationId = crypto.randomUUID();
		delete modal.pendingSave;
		if (!result.differentRequest && input.dueDatetime === pending.input.dueDatetime && input.dueDate === pending.input.dueDate) {
			input = { ...input, dueDatetime: result.reminder.dueDatetime ?? null, dueDate: result.reminder.dueDate ?? null };
		}
		if (!result.differentRequest && JSON.stringify(input.recurrence ?? null) === JSON.stringify(pending.input.recurrence ?? null)) {
			input = { ...input, recurrence: result.reminder.recurrence ?? null };
		}
		return await submit(apiFetch, prepare(modal, input));
	} catch (error) {
		if (sessionCurrent() && error instanceof RejectedSave) {
			delete modal.pendingSave;
			saveReminderDraft(modal);
		}
		throw error;
	}
}
