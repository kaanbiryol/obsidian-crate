import { useCallback, useRef } from 'react';
import { discardReminderDraft } from '../reminder-drafts';
import { capturePwaSession } from '../session-generation';
import type { ModalMode, ModalState, ShowToast } from '../types';
import type { useReminderEditor } from './useReminderEditor';
import type { useReminderMutations } from './useReminderMutations';

/** Editor policy stays mounted with the runtime, independently of its lazy screen. */
export function useReminderEditorActions({ editor, mutations, selectedProject, folderPath, ensureCanMutate, showToast }: {
	editor: Pick<ReturnType<typeof useReminderEditor>, 'setSaving' | 'closeModal' | 'openEditor' | 'openReminder'>;
	mutations: Pick<ReturnType<typeof useReminderMutations>, 'ready' | 'changes' | 'visibleReminders' | 'prepareEdit' | 'saveReminder' | 'deleteReminder'>;
	selectedProject: string | null;
	folderPath: string;
	ensureCanMutate: () => boolean;
	showToast: ShowToast;
}) {
	const { setSaving, closeModal, openEditor, openReminder } = editor;
	const { ready, changes, visibleReminders, prepareEdit } = mutations;
	const saving = useRef(false);

	const openModal = useCallback((mode: ModalMode, reminderId?: string, defaultProject?: string) => {
		if (!ready || !ensureCanMutate()) return;
		if (reminderId && changes.some(change => (change.status !== 'failed' || change.reviewRequired)
			&& (change.recordId === reminderId || change.optimistic?.id === reminderId))) {
			showToast('info', 'This reminder is still syncing. Retry its pending change first.');
			return;
		}
		const reminder = reminderId ? visibleReminders.find(item => item.id === reminderId) ?? null : null;
		openReminder(mode, reminder, defaultProject ?? selectedProject);
	}, [changes, ensureCanMutate, ready, visibleReminders, selectedProject, openReminder, showToast]);

	const editFailedChange = useCallback((operationId: string) => {
		if (!ready || !ensureCanMutate()) return;
		const draft = prepareEdit(operationId);
		if (draft) openEditor(draft);
	}, [ensureCanMutate, ready, prepareEdit, openEditor]);

	const editReminder = useCallback((id: string) => {
		const failedSave = changes.find(change => change.kind === 'save' && change.status === 'failed'
			&& (change.recordId === id || change.optimistic?.id === id));
		if (failedSave) editFailedChange(failedSave.operationId);
		else openModal('edit', id);
	}, [changes, editFailedChange, openModal]);

	const saveReminder = async (modal: ModalState): Promise<boolean> => {
		if (!ensureCanMutate() || saving.current) return false;
		const current = capturePwaSession();
		saving.current = true;
		setSaving(true);
		try {
			if (!await mutations.saveReminder(modal) || !current()) return false;
			discardReminderDraft(modal, folderPath);
			closeModal();
			return true;
		} catch (error) {
			if (current()) showToast('error', error instanceof Error ? error.message : String(error));
			return false;
		} finally {
			saving.current = false;
			if (current()) setSaving(false);
		}
	};

	const deleteReminder = async (id: string, expectedRevision?: string, filePath?: string): Promise<void> => {
		const current = capturePwaSession();
		if (await mutations.deleteReminder(id, expectedRevision, filePath) && current()) closeModal();
	};

	return { openModal, editFailedChange, editReminder, saveReminder, deleteReminder };
}
