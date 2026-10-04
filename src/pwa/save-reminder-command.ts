import { buildReminderMutationBody } from './reminder-mutation';
import { predictSavedReminder } from './reminder-optimistic-state';
import type { PendingReminderChange } from './reminder-outbox-types';
import type { ModalState, ReminderMutationBody, ReminderRecord, StoredConfig } from './types';
import { reminderOperationDay } from '@/protocol/reminder-operation';
import { newReminderOperationId } from './reminder-operation-id';

function fromInput(modal: ModalState, input: ReminderMutationBody, previous?: ReminderRecord): PendingReminderChange {
	const operationId = modal.operationId;
	if (!operationId) throw new Error('A reminder operation identity is required');
	const recordId = modal.reminderId ?? operationId;
	return {
		operationId, recordId, kind: 'save', path: modal.mode === 'edit' ? '/reminders/update' : '/reminders/create',
		method: 'POST', body: JSON.stringify({ ...input, id: recordId, operationId, filePath: modal.filePath, expectedRevision: modal.expectedRevision }),
		status: 'pending', attempts: 0, retryAt: 0,
		optimistic: predictSavedReminder(recordId, input, previous), previous,
		modal: JSON.parse(JSON.stringify(modal)) as ModalState,
	};
}

export async function createSaveReminderChange(modal: ModalState, config: StoredConfig, projects: string[], selectedProject: string | null, previous?: ReminderRecord): Promise<PendingReminderChange> {
	const input = buildReminderMutationBody({ draft: modal.draft, mode: modal.mode, config, projects, selectedProject });
	if (!input.content.trim()) throw new Error('Reminder title required');
	// Opening the editor creates a local draft identity; saving assigns a dated operation ID.
	if (!modal.operationId || reminderOperationDay(modal.operationId) === null) modal.operationId = await newReminderOperationId();
	return fromInput(modal, input, previous);
}
