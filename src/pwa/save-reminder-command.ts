import { buildReminderMutationBody } from './reminder-mutation';
import { predictSavedReminder } from './reminder-optimistic-state';
import type { PendingReminderChange } from './reminder-outbox-types';
import type { ModalState, ReminderMutationBody, ReminderRecord, StoredConfig } from './types';

function draftKey({ draft }: ModalState): string {
	const { activePicker: _picker, deleteConfirm: _confirm, ...input } = draft;
	return JSON.stringify(input);
}

function fromInput(modal: ModalState, input: ReminderMutationBody, previous?: ReminderRecord): PendingReminderChange {
	modal.operationId ??= crypto.randomUUID();
	const operationId = modal.operationId;
	const recordId = modal.reminderId ?? operationId;
	return {
		operationId, recordId, kind: 'save', path: modal.mode === 'edit' ? '/reminders/update' : '/reminders/create',
		method: 'POST', body: JSON.stringify({ ...input, id: recordId, operationId, filePath: modal.filePath, expectedRevision: modal.expectedRevision }),
		status: 'pending', attempts: 0, retryAt: 0,
		optimistic: predictSavedReminder(recordId, input, previous), previous,
		modal: JSON.parse(JSON.stringify(modal)) as ModalState,
	};
}

export function createSaveReminderChange(modal: ModalState, config: StoredConfig, projects: string[], selectedProject: string | null, previous?: ReminderRecord): PendingReminderChange {
	const input = buildReminderMutationBody({ draft: modal.draft, mode: modal.mode, config, projects, selectedProject });
	if (!input.content.trim()) throw new Error('Reminder title required');
	const change = fromInput(modal, input, previous);
	if (modal.pendingSave) {
		// Migrate attempts retained by older PWA versions without changing their payload.
		const attempted = JSON.parse(modal.pendingSave.body) as { id: string; operationId: string };
		change.operationId = attempted.operationId;
		change.recordId = attempted.id;
		change.body = modal.pendingSave.body;
		change.path = modal.pendingSave.path;
		change.ambiguous = true;
		change.optimistic = predictSavedReminder(attempted.id, input, previous);
		if (modal.pendingSave.draftKey !== draftKey(modal)) {
			change.followUp = { operationId: crypto.randomUUID(), input };
		}
	}
	return change;
}

/** A later edit is a separate command based on the original attempt's receipt. */
export function followUpReminderChange(change: PendingReminderChange, confirmed: ReminderRecord): PendingReminderChange | undefined {
	if (!change.followUp || !change.modal) return undefined;
	const pendingInput = change.modal.pendingSave?.input;
	const input = { ...change.followUp.input };
	if (pendingInput && input.dueDate === pendingInput.dueDate && input.dueDatetime === pendingInput.dueDatetime) {
		input.dueDate = confirmed.dueDate ?? null;
		input.dueDatetime = confirmed.dueDatetime ?? null;
	}
	if (pendingInput && JSON.stringify(input.recurrence ?? null) === JSON.stringify(pendingInput.recurrence ?? null)) input.recurrence = confirmed.recurrence;
	const modal: ModalState = { ...change.modal, mode: 'edit', reminderId: confirmed.id,
		operationId: change.followUp.operationId, expectedRevision: confirmed.revision,
		filePath: confirmed.filePath, pendingSave: undefined };
	return fromInput(modal, input, confirmed);
}
