import { useCallback, useState } from 'react';
import { flushSync } from 'react-dom';
import { buildModalDraft } from './reminder-drafts';
import type { ModalMode, ModalState, ReminderRecord } from '../types';
import { useSheetTransition } from '../../hooks/useSheetTransition';
import { refreshReminderOperationDay } from '../outbox/reminder-operation-id';

/** Owns editor presentation; callers decide whether the reminder can be edited. */
export function useReminderEditor(setSettingsOpen: (open: boolean) => void) {
	const [modal, setModal] = useState<ModalState | null>(null);
	const [saving, setSaving] = useState(false);
	const finalizeClose = useCallback(() => setModal(null), []);
	const transition = useSheetTransition(finalizeClose);
	const { cancelClose, requestClose } = transition;

	const resetEditor = useCallback(() => {
		cancelClose();
		setSaving(false);
		setModal(null);
	}, [cancelClose]);
	const closeModal = useCallback(() => {
		if (!modal) return;
		setSaving(false);
		requestClose();
	}, [modal, requestClose]);
	const openEditor = useCallback((draft: ModalState, synchronous = true) => {
		cancelClose();
		setSettingsOpen(false);
		setSaving(false);
		// A tap must mount the editor before its synchronous keyboard/focus window ends.
		if (synchronous) flushSync(() => setModal(draft));
		else setModal(draft);
		// Its save then issues an operation ID without waiting on the server.
		refreshReminderOperationDay();
	}, [cancelClose, setSettingsOpen]);
	const openReminder = useCallback((mode: ModalMode, reminder: ReminderRecord | null, defaultProject: string | null, synchronous = true) => {
		openEditor({
			mode, reminderId: reminder?.id, expectedRevision: reminder?.revision,
			filePath: reminder?.filePath, operationId: crypto.randomUUID(),
			draft: buildModalDraft(reminder, defaultProject),
		}, synchronous);
	}, [openEditor]);

	return { modal, saving, setSaving, transition, closeModal, resetEditor, openEditor, openReminder };
}
