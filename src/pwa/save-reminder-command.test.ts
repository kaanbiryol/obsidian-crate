import { describe, expect, it } from 'vitest';
import { createSaveReminderChange, followUpReminderChange } from './save-reminder-command';
import { buildReminderMutationBody } from './reminder-mutation';
import type { PendingReminderChange } from './reminder-outbox-types';
import type { ModalState, ReminderRecord, StoredConfig } from './types';

const config: StoredConfig = { folderPath: 'Reminders', upcomingDays: 7, allDayNotificationTime: null };
const projects = ['Inbox', 'Work'];

function legacyModal(mode: ModalState['mode'] = 'create', draftOverrides: Partial<ModalState['draft']> = {}): ModalState {
	const operationId = crypto.randomUUID();
	const modal: ModalState = {
		mode, operationId, reminderId: mode === 'edit' ? 'existing-reminder' : undefined,
		expectedRevision: mode === 'edit' ? 'original-revision' : undefined,
		filePath: mode === 'edit' ? 'Reminders/Original.md' : undefined,
		draft: { content: 'Original reminder', description: 'Original notes', project: 'Inbox', defaultProject: 'Inbox',
			priority: 4, dueDate: '', dueTime: '', activePicker: null, deleteConfirm: false, ...draftOverrides },
	};
	const input = buildReminderMutationBody({ draft: modal.draft, mode, config, projects, selectedProject: null });
	const { activePicker: _picker, deleteConfirm: _confirm, ...persistedDraft } = modal.draft;
	modal.pendingSave = {
		path: mode === 'edit' ? '/reminders/update' : '/reminders/create', input,
		draftKey: JSON.stringify(persistedDraft),
		// Formatting makes accidental reconstruction distinguishable from an exact retry.
		body: JSON.stringify({ ...input, id: modal.reminderId ?? operationId, operationId,
			filePath: modal.filePath, expectedRevision: modal.expectedRevision }, null, 2),
	};
	return modal;
}

function receipt(change: PendingReminderChange, overrides: Partial<ReminderRecord> = {}): ReminderRecord {
	return { id: change.recordId!, content: 'Original reminder', description: 'Original notes', completed: false,
		project: 'Inbox', priority: 4, filePath: 'Reminders/Confirmed.md', revision: 'server-revision', ...overrides };
}

function serialized(change: PendingReminderChange): PendingReminderChange {
	return JSON.parse(JSON.stringify(change)) as PendingReminderChange;
}

function body(change: PendingReminderChange): Record<string, unknown> {
	return JSON.parse(change.body) as Record<string, unknown>;
}

describe('legacy pending reminder save migration', () => {
	it.each(['create', 'edit'] as const)('retries an ambiguous %s exactly while keeping later edits visible and durable', mode => {
		const modal = legacyModal(mode);
		const attempted = { ...modal.pendingSave! };
		modal.draft = { ...modal.draft, content: 'My correction', description: 'Additional notes', project: 'Work', priority: 1 };
		const change = createSaveReminderChange(modal, config, projects, null);

		expect(change).toMatchObject({ body: attempted.body, path: attempted.path, ambiguous: true, status: 'pending',
			operationId: modal.operationId, recordId: modal.reminderId ?? modal.operationId });
		expect(body(change)).toMatchObject({ content: 'Original reminder', description: 'Original notes', project: 'Inbox', priority: 4 });
		expect(change.optimistic).toMatchObject({ id: change.recordId, content: 'My correction', description: 'Additional notes', project: 'Work', priority: 1 });
		expect(change.followUp!.operationId).toEqual(expect.any(String));
		expect(change.followUp!.input).toMatchObject({ content: 'My correction', description: 'Additional notes', project: 'Work', priority: 1 });
		expect(change.followUp!.operationId).not.toBe(change.operationId);

		const restored = serialized(change);
		expect(restored.followUp).toEqual(change.followUp);
		expect(restored.modal!.draft).toEqual(modal.draft);
		expect(restored.modal!.pendingSave!.body).toBe(attempted.body);
		modal.draft.content = 'Another unsaved edit';
		expect(change.modal!.draft.content).toBe('My correction');
	});

	it('creates a distinct correction command from the original receipt after a reload', () => {
		const modal = legacyModal();
		modal.draft.content = 'My correction';
		const original = serialized(createSaveReminderChange(modal, config, projects, null));
		const confirmed = receipt(original);
		const correction = followUpReminderChange(original, confirmed)!;

		expect(correction).toMatchObject({ kind: 'save', path: '/reminders/update', method: 'POST',
			operationId: original.followUp!.operationId, recordId: confirmed.id, previous: confirmed, status: 'pending', attempts: 0 });
		expect(correction.operationId).not.toBe(original.operationId);
		expect(body(correction)).toMatchObject({ id: confirmed.id, operationId: original.followUp!.operationId,
			content: 'My correction', expectedRevision: 'server-revision', filePath: 'Reminders/Confirmed.md' });
		expect(correction.modal).toMatchObject({ mode: 'edit', reminderId: confirmed.id, operationId: correction.operationId,
			expectedRevision: 'server-revision', filePath: 'Reminders/Confirmed.md' });
		expect(correction.modal!.pendingSave).toBeUndefined();
		expect(correction.followUp).toBeUndefined();
		expect(correction.optimistic).toMatchObject({ id: confirmed.id, content: 'My correction', revision: 'server-revision' });
		expect(body(original).content).toBe('Original reminder');
	});

	it('does not create a follow-up for an unchanged draft or changes only to open editor controls', () => {
		const modal = legacyModal();
		modal.draft.activePicker = 'date';
		modal.draft.deleteConfirm = true;
		const change = createSaveReminderChange(modal, config, projects, null);
		expect(change.body).toBe(modal.pendingSave!.body);
		expect(change.ambiguous).toBe(true);
		expect(change.followUp).toBeUndefined();
		expect(followUpReminderChange(change, receipt(change))).toBeUndefined();
	});

	it('keeps the confirmed recurrence schedule and completion count when correcting only text', () => {
		const modal = legacyModal('edit', { dueDate: '2099-01-01', dueTime: '09:00',
			recurrence: { frequency: 'daily', timezone: 'UTC', count: 10, completedCount: 2, hour: 9, minute: 0 } });
		modal.draft.content = 'Corrected recurring reminder';
		const original = serialized(createSaveReminderChange(modal, config, projects, null));
		const confirmed = receipt(original, { dueDate: '2099-01-04', dueDatetime: '2099-01-04T09:00:00.000Z',
			recurrence: { ...modal.draft.recurrence!, completedCount: 3 } });
		const correction = followUpReminderChange(original, confirmed)!;

		expect(body(correction)).toMatchObject({ content: 'Corrected recurring reminder', dueDate: confirmed.dueDate,
			dueDatetime: confirmed.dueDatetime, recurrence: confirmed.recurrence });
		expect(correction.optimistic).toMatchObject({ dueDate: confirmed.dueDate, dueDatetime: confirmed.dueDatetime,
			recurrence: { frequency: 'daily', count: 10, completedCount: 3 } });
		expect(original.followUp!.input.recurrence!.completedCount).toBe(2);
	});

	it('keeps an explicit schedule correction instead of replacing it with the original receipt schedule', () => {
		const modal = legacyModal('edit', { dueDate: '2099-01-01', recurrence: { frequency: 'daily', timezone: 'UTC' } });
		modal.draft.dueDate = '2099-02-01';
		modal.draft.recurrence = { frequency: 'weekly', timezone: 'UTC' };
		const original = createSaveReminderChange(modal, config, projects, null);
		const confirmed = receipt(original, { dueDate: '2099-01-02', recurrence: { frequency: 'daily', timezone: 'UTC', completedCount: 1 } });
		const correction = followUpReminderChange(original, confirmed)!;
		expect(body(correction)).toMatchObject({ dueDate: '2099-02-01', dueDatetime: null, recurrence: { frequency: 'weekly', timezone: 'UTC' } });
		expect(correction.optimistic!.recurrence).toEqual(modal.draft.recurrence);
	});
});
