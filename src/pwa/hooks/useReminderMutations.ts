import { useMemo, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { capturePwaSession } from '../session-generation';
import { discardReminderDraft } from '../reminder-drafts';
import { applyReminderChanges, predictReminderCompletion } from '../reminder-optimistic-state';
import type { PendingReminderChange } from '../reminder-outbox-types';
import { useReminderOutbox } from './useReminderOutbox';
import type { ApiFetch, LoadReminders, ModalState, ReminderRecord, ShowToast, StoredConfig } from '../types';

export function useReminderMutations(options: {
	apiFetch: ApiFetch;
	authToken: string | null;
	bootstrapped: boolean;
	beginLocalMutation: () => () => void;
	commitReminderState: (reminders: ReminderRecord[], projects?: string[]) => void | Promise<void>;
	closeModal: () => void;
	config: StoredConfig;
	ensureCanMutate: () => boolean;
	reminders: ReminderRecord[];
	projects: string[];
	projectsRef: MutableRefObject<string[]>;
	remindersRef: MutableRefObject<ReminderRecord[]>;
	selectedProject: string | null;
	setProjects: Dispatch<SetStateAction<string[]>>;
	setReminders: Dispatch<SetStateAction<ReminderRecord[]>>;
	setSaving: Dispatch<SetStateAction<boolean>>;
	showToast: ShowToast;
	loadReminders: LoadReminders;
	hasSnapshot?: boolean;
	canRecover?: boolean;
}) {
	const { changes, ready, outboxRef, storageError, retryInitialization, recoveryChanges, recoverChanges, quarantinedChanges, removeQuarantinedChanges } = useReminderOutbox({ ...options, folderPath: options.config.folderPath });
	const { closeModal, config, ensureCanMutate, projects, remindersRef, selectedProject, setReminders, setSaving, showToast } = options;
	const preparingRef = useRef(false);
	const report = (error: unknown) => showToast('error', error instanceof Error ? error.message : String(error));
	const enqueue = (change: PendingReminderChange) => {
		if (!ready || !outboxRef.current) throw new Error('Pending changes are still loading. Reopen Crate if this continues.');
		outboxRef.current.enqueue(change);
		void outboxRef.current.drain();
	};

	const saveReminder = async (modal: ModalState) => {
		if (!ensureCanMutate() || preparingRef.current) return;
		const sessionCurrent = capturePwaSession();
		preparingRef.current = true;
		setSaving(true);
		try {
			const { createSaveReminderChange } = await import('../save-reminder-command');
			if (!sessionCurrent()) return;
			const previous = remindersRef.current.find(item => item.id === modal.reminderId);
			enqueue(createSaveReminderChange(modal, config, projects, selectedProject, previous));
			discardReminderDraft(modal, config.folderPath);
			closeModal();
		} catch (error) { if (sessionCurrent()) report(error); }
		finally { preparingRef.current = false; if (sessionCurrent()) setSaving(false); }
	};

	const recordChange = (id: string, kind: 'delete' | 'complete', extra: Record<string, unknown>, optimistic?: ReminderRecord, expectedRevision?: string, filePath?: string): PendingReminderChange => {
		const previous = remindersRef.current.find(item => item.id === id);
		if (!previous) throw new Error('Refresh reminders before changing this reminder.');
		const operationId = crypto.randomUUID();
		return {
			operationId, recordId: id, kind, previous, optimistic,
			path: kind === 'delete' ? '/reminders/delete' : '/reminders/set-completed',
			method: kind === 'delete' ? 'DELETE' : 'POST',
			body: JSON.stringify({ folderPath: config.folderPath, id, operationId,
				filePath: filePath ?? previous.filePath, expectedRevision: expectedRevision ?? previous.revision, ...extra }),
			status: 'pending', attempts: 0, retryAt: 0,
		};
	};
	const toggleReminderCompleted = async (id: string, completed: boolean) => {
		if (!ensureCanMutate()) return;
		try {
			const previous = remindersRef.current.find(item => item.id === id);
			if (!previous) throw new Error('Refresh reminders before changing this reminder.');
			enqueue(recordChange(id, 'complete', { completed: !completed }, predictReminderCompletion(previous, !completed)));
		} catch (error) { report(error); }
	};
	const deleteReminder = async (id: string, expectedRevision?: string, filePath?: string) => {
		if (!ensureCanMutate()) return;
		try {
			enqueue(recordChange(id, 'delete', {}, undefined, expectedRevision, filePath));
			closeModal();
		} catch (error) { report(error); }
	};
	const persistReorder = async (project: string, orderedIds: string[]) => {
		if (!ensureCanMutate()) { setReminders(current => [...current]); return; }
		try {
			const operationId = crypto.randomUUID();
			enqueue({
				operationId, kind: 'reorder', project, orderedIds: [...orderedIds], path: '/reminders/reorder', method: 'POST',
				body: JSON.stringify({ folderPath: config.folderPath, project, orderedIds,
					expectedOrder: remindersRef.current.filter(item => item.project === project).map(item => item.id), operationId }),
				status: 'pending', attempts: 0, retryAt: 0,
			});
		} catch (error) { setReminders(current => [...current]); report(error); }
	};
	const retryChange = (operationId: string) => {
		try { outboxRef.current?.retry(operationId); void outboxRef.current?.drain(); }
		catch (error) { report(error); }
	};
	const discardChange = (operationId: string) => {
		try { outboxRef.current?.discard(operationId); }
		catch (error) { report(error); }
	};
	const prepareEdit = (operationId: string): ModalState | null => {
		const change = changes.find(item => item.operationId === operationId && item.status === 'failed' && !item.ambiguous && item.kind === 'save');
		if (!change?.modal) return null;
		const modal = JSON.parse(JSON.stringify(change.modal)) as ModalState;
		const current = remindersRef.current.find(item => item.id === change.recordId);
		if (modal.mode === 'edit' && !current) {
			modal.mode = 'create';
			delete modal.reminderId;
			showToast('info', 'The original reminder was deleted. Save your draft as a new reminder.');
		}
		modal.expectedRevision = current?.revision;
		modal.filePath = current?.filePath;
		modal.recovery = true;
		delete modal.pendingSave;
		return modal;
	};
	const visible = useMemo(() => applyReminderChanges(options.reminders, projects, changes), [options.reminders, projects, changes]);
	return { saveReminder, toggleReminderCompleted, deleteReminder, persistReorder, ...visible, changes, ready, retryChange, discardChange, prepareEdit, storageError, retryInitialization, recoveryChanges, recoverChanges, quarantinedChanges, removeQuarantinedChanges };
}
