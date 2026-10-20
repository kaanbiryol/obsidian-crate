import { useCallback, useState } from 'react';
import { discardReminderDraft, restoreReminderDraft, saveReminderDraft } from '../reminders/editor/reminder-drafts';
import type { ModalDraft, ModalState } from '../types';

/** Editor state that survives reloads: every edit is saved for this folder until the editor discards it. */
export function usePersistedReminderDraft(initialModal: ModalState, folderPath: string) {
	const [modal, setModal] = useState(() => restoreReminderDraft(initialModal, folderPath));
	const patchDraft = useCallback((patch: Partial<ModalDraft>) => {
		setModal(current => {
			const next = { ...current, draft: { ...current.draft, ...patch } };
			saveReminderDraft(next, folderPath);
			return next;
		});
	}, [folderPath]);
	const discardDraft = useCallback(() => discardReminderDraft(modal, folderPath), [modal, folderPath]);
	return { modal, patchDraft, discardDraft };
}
