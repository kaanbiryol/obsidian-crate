import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { useReminderEditorActions } from './useReminderEditorActions';
import { discardReminderDraft } from '../reminder-drafts';
import { buildModalDraft } from '../reminder-modal-draft';
import { invalidatePwaSession } from '../session-generation';
import type { ModalState } from '../types';

vi.mock('../reminder-drafts', () => ({ discardReminderDraft: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

const modal: ModalState = { mode: 'create', operationId: 'save-one',
	draft: { ...buildModalDraft(null, 'Inbox'), content: 'Keep my draft' } };

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(done => { resolve = done; });
	return { promise, resolve };
}

function harness() {
	const editor = { setSaving: vi.fn(), closeModal: vi.fn(), openEditor: vi.fn(), openReminder: vi.fn() };
	const mutations = { ready: true, changes: [], visibleReminders: [], prepareEdit: vi.fn(),
		saveReminder: vi.fn(async (_modal: ModalState) => true), deleteReminder: vi.fn(async () => true) };
	const showToast = vi.fn();
	const hook = renderHook(() => useReminderEditorActions({ editor, mutations, selectedProject: null,
		folderPath: 'Reminders', ensureCanMutate: () => true, showToast }));
	return { hook, editor, mutations, showToast };
}

it('keeps the editor and draft until a delayed save succeeds, ignoring duplicate saves', async () => {
	const h = harness(), saved = createDeferred<boolean>();
	h.mutations.saveReminder.mockReturnValueOnce(saved.promise);
	let pending!: Promise<boolean>;
	act(() => { pending = h.hook.current.saveReminder(modal); });
	expect(h.editor.setSaving).toHaveBeenLastCalledWith(true);
	expect(h.editor.closeModal).not.toHaveBeenCalled();
	expect(discardReminderDraft).not.toHaveBeenCalled();
	await expect(h.hook.current.saveReminder(modal)).resolves.toBe(false);
	expect(h.mutations.saveReminder).toHaveBeenCalledOnce();
	await act(async () => { saved.resolve(true); await pending; });
	expect(discardReminderDraft).toHaveBeenCalledWith(modal, 'Reminders');
	expect(h.editor.closeModal).toHaveBeenCalledOnce();
	expect(h.editor.setSaving).toHaveBeenLastCalledWith(false);
});

it.each(['rejected', 'failed'] as const)('retains the draft and editor when a save is %s', async failure => {
	const h = harness();
	if (failure === 'rejected') h.mutations.saveReminder.mockRejectedValueOnce(new Error('Storage unavailable'));
	else h.mutations.saveReminder.mockResolvedValueOnce(false);
	await act(async () => { expect(await h.hook.current.saveReminder(modal)).toBe(false); });
	expect(discardReminderDraft).not.toHaveBeenCalled();
	expect(h.editor.closeModal).not.toHaveBeenCalled();
	expect(h.editor.setSaving).toHaveBeenLastCalledWith(false);
});

it('does not change editor state after logout during a save', async () => {
	const h = harness(), saved = createDeferred<boolean>();
	h.mutations.saveReminder.mockReturnValueOnce(saved.promise);
	const pending = h.hook.current.saveReminder(modal);
	invalidatePwaSession();
	h.hook.unmount();
	await act(async () => { saved.resolve(true); expect(await pending).toBe(false); });
	expect(discardReminderDraft).not.toHaveBeenCalled();
	expect(h.editor.closeModal).not.toHaveBeenCalled();
	expect(h.editor.setSaving).toHaveBeenCalledTimes(1);
});

it('closes the editor only when deletion succeeds in the current session', async () => {
	const h = harness();
	h.mutations.deleteReminder.mockResolvedValueOnce(false);
	await h.hook.current.deleteReminder('one');
	expect(h.editor.closeModal).not.toHaveBeenCalled();
	await h.hook.current.deleteReminder('one');
	expect(h.editor.closeModal).toHaveBeenCalledOnce();
	const deleted = createDeferred<boolean>();
	h.mutations.deleteReminder.mockReturnValueOnce(deleted.promise);
	const pending = h.hook.current.deleteReminder('two');
	invalidatePwaSession(); deleted.resolve(true); await pending;
	expect(h.editor.closeModal).toHaveBeenCalledOnce();
});
