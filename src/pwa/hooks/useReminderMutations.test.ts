import { afterEach, describe, expect, it, vi } from 'vitest';
import { useReminderMutations } from './useReminderMutations';
import { useReminderOutbox } from './useReminderOutbox';
import { invalidatePwaSession } from '../session-generation';
import { restoreReminderDraft, saveReminderDraft } from '../reminder-drafts';
import type { PendingReminderChange } from '../reminder-outbox-types';
import type { ModalState, ReminderRecord } from '../types';

vi.mock('react', () => ({ useMemo: (factory: () => unknown) => factory(), useRef: (current: unknown) => ({ current }) }));
vi.mock('./useReminderOutbox', () => ({ useReminderOutbox: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function draft(overrides: Partial<ModalState> = {}): ModalState {
	return { mode: 'create', draft: { content: 'My reminder', description: 'Details', project: 'Inbox', defaultProject: 'Inbox',
		priority: 4, dueDate: '', dueTime: '', activePicker: null, deleteConfirm: false }, ...overrides };
}

function harness() {
	const memory = new Map<string, string>();
	vi.stubGlobal('sessionStorage', {
		setItem: (key: string, value: string) => memory.set(key, value),
		getItem: (key: string) => memory.get(key) ?? null,
		removeItem: (key: string) => memory.delete(key),
	});
	const remindersRef = { current: ['one', 'two'].map(id => ({ id, content: id, completed: false, priority: 4,
		revision: id, filePath: 'Reminders/Inbox.md', project: 'Inbox' })) as ReminderRecord[] };
	const changes: PendingReminderChange[] = [];
	const outbox = {
		enqueue: vi.fn((change: PendingReminderChange) => { changes.push(change); }),
		drain: vi.fn(() => new Promise<void>(() => {})),
		retry: vi.fn(), discard: vi.fn(), refresh: vi.fn(() => changes),
	};
	const state = { changes, ready: true, outboxRef: { current: outbox }, storageError: null, retryInitialization: vi.fn(), recoveryChanges: [], recoverChanges: vi.fn(), quarantinedChanges: [], removeQuarantinedChanges: vi.fn(async () => true) };
	vi.mocked(useReminderOutbox).mockReturnValue(state);
	const apiFetch = vi.fn<Parameters<typeof useReminderMutations>[0]['apiFetch']>();
	const closeModal = vi.fn(); const showToast = vi.fn(); const setSaving = vi.fn();
	const ensureCanMutate = vi.fn(() => true);
	const commitReminderState = vi.fn();
	const setReminders = vi.fn<Parameters<typeof useReminderMutations>[0]['setReminders']>(value => {
		remindersRef.current = typeof value === 'function' ? value(remindersRef.current) : value;
	});
	const options: Parameters<typeof useReminderMutations>[0] = {
		apiFetch, authToken: 'token', bootstrapped: true, beginLocalMutation: () => () => {}, ensureCanMutate,
		commitReminderState, setReminders, remindersRef, reminders: remindersRef.current, projectsRef: { current: ['Inbox'] },
		config: { folderPath: 'Reminders', allDayNotificationTime: null, upcomingDays: 7 },
		projects: ['Inbox'], selectedProject: null, closeModal, setProjects: vi.fn(), setSaving, showToast, loadReminders: vi.fn(),
	};
	const render = () => useReminderMutations({ ...options, reminders: remindersRef.current });
	return { hook: render(), render, state, outbox, changes, remindersRef, apiFetch, closeModal, showToast,
		setSaving, ensureCanMutate, commitReminderState, setReminders, memory };
}

function body(change: PendingReminderChange): Record<string, unknown> { return JSON.parse(change.body) as Record<string, unknown>; }

describe('PWA optimistic mutations', () => {
	it('persists a save and closes the editor without waiting for its network attempt', async () => {
		const { hook, render, outbox, changes, closeModal, setSaving, apiFetch, commitReminderState, memory } = harness();
		const modal = draft();
		saveReminderDraft(modal, 'Reminders');
		await hook.saveReminder(modal);

		expect(outbox.enqueue).toHaveBeenCalledOnce();
		expect(outbox.drain).toHaveBeenCalledOnce();
		expect(closeModal).toHaveBeenCalledOnce();
		expect(outbox.enqueue.mock.invocationCallOrder[0]).toBeLessThan(closeModal.mock.invocationCallOrder[0]!);
		expect(setSaving.mock.calls).toEqual([[true], [false]]);
		expect(memory.size).toBe(0);
		expect(apiFetch).not.toHaveBeenCalled();
		expect(commitReminderState).not.toHaveBeenCalled();
		expect(changes[0]).toMatchObject({ kind: 'save', path: '/reminders/create', status: 'pending',
			operationId: modal.operationId, recordId: modal.operationId, modal });
		expect(body(changes[0]!)).toMatchObject({ content: 'My reminder', description: 'Details',
			folderPath: 'Reminders', id: modal.operationId, operationId: modal.operationId });
		expect(render().visibleReminders.at(-1)).toMatchObject({ id: modal.operationId, content: 'My reminder', completed: false });
	});

	it('keeps the editor and saved draft when durable enqueue fails', async () => {
		const { hook, outbox, closeModal, showToast, setSaving } = harness();
		const modal = draft();
		saveReminderDraft(modal, 'Reminders');
		outbox.enqueue.mockImplementationOnce(() => { throw new Error('Device storage is full'); });
		await hook.saveReminder(modal);

		expect(closeModal).not.toHaveBeenCalled();
		expect(outbox.drain).not.toHaveBeenCalled();
		expect(showToast).toHaveBeenCalledWith('error', 'Device storage is full');
		expect(setSaving.mock.calls).toEqual([[true], [false]]);
		expect(restoreReminderDraft(draft(), 'Reminders').draft).toEqual(modal.draft);
	});

	it('gives separate creates distinct durable identities', async () => {
		const { hook, changes } = harness();
		await hook.saveReminder(draft());
		await hook.saveReminder(draft());
		expect(changes).toHaveLength(2);
		expect(changes[0]!.operationId).not.toBe(changes[1]!.operationId);
		expect(changes.map(change => change.recordId)).toEqual(changes.map(change => change.operationId));
	});

	it('does not enqueue a blank title or discard its draft', async () => {
		const { hook, outbox, closeModal, showToast, memory } = harness();
		const modal = draft(); modal.draft.content = '  \n  ';
		saveReminderDraft(modal, 'Reminders');
		await hook.saveReminder(modal);
		expect(outbox.enqueue).not.toHaveBeenCalled();
		expect(closeModal).not.toHaveBeenCalled();
		expect(memory.size).toBe(1);
		expect(showToast).toHaveBeenCalledWith('error', 'Reminder title required');
	});

	it('prevents double submission while the save command is being prepared', async () => {
		const { hook, outbox, closeModal } = harness();
		const modal = draft();
		await Promise.all([hook.saveReminder(modal), hook.saveReminder(modal)]);
		expect(outbox.enqueue).toHaveBeenCalledOnce();
		expect(closeModal).toHaveBeenCalledOnce();
	});

	it('does not enqueue a save prepared across logout', async () => {
		const { hook, outbox, closeModal, showToast } = harness();
		const saving = hook.saveReminder(draft());
		invalidatePwaSession();
		await saving;
		expect(outbox.enqueue).not.toHaveBeenCalled();
		expect(closeModal).not.toHaveBeenCalled();
		expect(showToast).not.toHaveBeenCalled();
	});

	it('keeps changes out of an outbox that has not finished loading', async () => {
		const { render, state, outbox, closeModal, showToast } = harness();
		state.ready = false;
		await render().saveReminder(draft());
		expect(outbox.enqueue).not.toHaveBeenCalled();
		expect(closeModal).not.toHaveBeenCalled();
		expect(showToast).toHaveBeenCalledWith('error', expect.stringContaining('still loading'));
	});

	it('honors the mutation guard before saving, completing, deleting, or reordering', async () => {
		const { hook, outbox, ensureCanMutate, closeModal, setSaving, setReminders } = harness();
		ensureCanMutate.mockReturnValue(false);
		await hook.saveReminder(draft());
		await hook.toggleReminderCompleted('one', false);
		await hook.deleteReminder('one');
		await hook.persistReorder('Inbox', ['two', 'one']);
		expect(outbox.enqueue).not.toHaveBeenCalled();
		expect(closeModal).not.toHaveBeenCalled();
		expect(setSaving).not.toHaveBeenCalled();
		expect(setReminders).toHaveBeenCalledOnce();
	});

	it('preserves a failed edit draft while refreshing its revision and keeping its operation identity', async () => {
		const { hook, render, changes, remindersRef } = harness();
		const modal = draft({ mode: 'edit', reminderId: 'one', operationId: 'failed-edit-operation', expectedRevision: 'old-revision', filePath: 'Reminders/Inbox.md' });
		modal.draft = { ...modal.draft, content: 'My correction', description: 'All my notes', priority: 1,
			dueDate: '2099-01-01', dueTime: '09:15', originalDueDatetime: '2099-01-01T09:15:00.000Z',
			recurrence: { frequency: 'daily', timezone: 'UTC', completedCount: 3 }, activePicker: 'date', deleteConfirm: true };
		await hook.saveReminder(modal);
		changes[0]!.status = 'failed';
		remindersRef.current[0] = { ...remindersRef.current[0]!, revision: 'latest-revision', filePath: 'Reminders/Moved.md' };

		const prepared = render().prepareEdit(changes[0]!.operationId);
		expect(prepared).toEqual({ ...modal, expectedRevision: 'latest-revision', filePath: 'Reminders/Moved.md', recovery: true });
		expect(prepared!.draft).not.toBe(changes[0]!.modal!.draft);
		prepared!.draft.content = 'Updated correction';
		expect(changes[0]!.modal!.draft.content).toBe('My correction');
		await render().saveReminder(prepared!);
		expect(body(changes[1]!)).toMatchObject({ id: 'one', operationId: modal.operationId,
			expectedRevision: 'latest-revision', filePath: 'Reminders/Moved.md', content: 'Updated correction' });
	});

	it('only prepares definitely failed saves and recovers a remotely deleted reminder as a new draft', async () => {
		const { hook, render, changes, remindersRef } = harness();
		await hook.saveReminder(draft({ mode: 'edit', reminderId: 'one', expectedRevision: 'old-revision', filePath: 'Reminders/Original.md' }));
		const operationId = changes[0]!.operationId;
		expect(render().prepareEdit(operationId)).toBeNull();
		changes[0]!.status = 'uncertain';
		expect(render().prepareEdit(operationId)).toBeNull();
		changes[0]!.status = 'failed';
		remindersRef.current = remindersRef.current.filter(item => item.id !== 'one');
		const recovered = render().prepareEdit(operationId);
		expect(recovered).toEqual({ mode: 'create', operationId, reminderId: undefined, expectedRevision: undefined,
			filePath: undefined, draft: changes[0]!.modal!.draft, recovery: true });
		expect(recovered!.draft).not.toBe(changes[0]!.modal!.draft);
		await render().saveReminder(recovered!);
		expect(changes[1]).toMatchObject({ path: '/reminders/create', operationId, recordId: operationId });
		expect(body(changes[1]!)).toMatchObject({ id: operationId, operationId, content: 'My reminder', description: 'Details' });
		expect(body(changes[1]!)).not.toHaveProperty('expectedRevision');
		expect(body(changes[1]!)).not.toHaveProperty('filePath');
		expect(changes[0]!.modal!.reminderId).toBe('one');
	});

	it('never prepares an ambiguous command for editing even if it is marked failed', async () => {
		const { hook, render, changes } = harness();
		await hook.saveReminder(draft({ mode: 'edit', reminderId: 'one' }));
		changes[0]!.status = 'failed';
		changes[0]!.ambiguous = true;
		expect(render().prepareEdit(changes[0]!.operationId)).toBeNull();
		expect(changes[0]!.modal!.draft.content).toBe('My reminder');
	});

	it('completes a reminder immediately while retaining its confirmed state and revision', async () => {
		const { hook, render, changes, remindersRef, setSaving } = harness();
		await hook.toggleReminderCompleted('one', false);
		expect(render().visibleReminders[0]!.completed).toBe(true);
		expect(remindersRef.current[0]!.completed).toBe(false);
		expect(changes[0]).toMatchObject({ kind: 'complete', path: '/reminders/set-completed', method: 'POST' });
		expect(body(changes[0]!)).toMatchObject({ id: 'one', completed: true, expectedRevision: 'one', filePath: 'Reminders/Inbox.md' });
		expect(setSaving).not.toHaveBeenCalled();
	});

	it('advances a recurring occurrence in the immediate completion projection', async () => {
		const { hook, render, remindersRef } = harness();
		remindersRef.current[0] = { ...remindersRef.current[0]!, dueDate: '2099-01-01', dueDatetime: '2099-01-01T09:00:00.000Z',
			recurrence: { frequency: 'daily', timezone: 'UTC', hour: 9, minute: 0, completedCount: 1 } };
		await hook.toggleReminderCompleted('one', false);
		expect(render().visibleReminders[0]).toMatchObject({ completed: false, dueDatetime: '2099-01-02T09:00:00.000Z', recurrence: { completedCount: 2 } });
		expect(remindersRef.current[0].recurrence!.completedCount).toBe(1);
	});

	it('deletes immediately using the revision and path captured by the editor', async () => {
		const { hook, render, changes, remindersRef, closeModal, setSaving } = harness();
		await hook.deleteReminder('one', 'editor-revision', 'Reminders/Original.md');
		expect(closeModal).toHaveBeenCalledOnce();
		expect(render().visibleReminders.map(item => item.id)).toEqual(['two']);
		expect(remindersRef.current).toHaveLength(2);
		expect(changes[0]).toMatchObject({ kind: 'delete', path: '/reminders/delete', method: 'DELETE' });
		expect(body(changes[0]!)).toMatchObject({ id: 'one', expectedRevision: 'editor-revision', filePath: 'Reminders/Original.md' });
		expect(setSaving).not.toHaveBeenCalled();
	});

	it('keeps the editor open when a pending change prevents deleting the reminder', async () => {
		const { hook, outbox, closeModal, showToast } = harness();
		outbox.enqueue.mockImplementationOnce(() => { throw new Error('Resolve the pending change before changing this reminder again.'); });
		await hook.deleteReminder('one');
		expect(closeModal).not.toHaveBeenCalled();
		expect(outbox.drain).not.toHaveBeenCalled();
		expect(showToast).toHaveBeenCalledWith('error', expect.stringContaining('pending change'));
	});

	it('reorders immediately and captures the confirmed order for conflict checking', async () => {
		const { hook, render, changes, remindersRef } = harness();
		const orderedIds = ['two', 'one'];
		await hook.persistReorder('Inbox', orderedIds);
		orderedIds.reverse();
		expect(render().visibleReminders.map(item => item.id)).toEqual(['two', 'one']);
		expect(remindersRef.current.map(item => item.id)).toEqual(['one', 'two']);
		expect(body(changes[0]!)).toMatchObject({ project: 'Inbox', orderedIds: ['two', 'one'], expectedOrder: ['one', 'two'] });
	});

	it('routes recovery actions to the durable outbox and reports storage failures', () => {
		const { hook, outbox, showToast } = harness();
		hook.retryChange('retry-id');
		expect(outbox.retry).toHaveBeenCalledWith('retry-id');
		expect(outbox.drain).toHaveBeenCalledOnce();
		hook.discardChange('discard-id');
		expect(outbox.discard).toHaveBeenCalledWith('discard-id');
		outbox.retry.mockImplementationOnce(() => { throw new Error('Retry storage failed'); });
		hook.retryChange('retry-id');
		expect(showToast).toHaveBeenCalledWith('error', 'Retry storage failed');
		expect(outbox.drain).toHaveBeenCalledOnce();
	});
});
