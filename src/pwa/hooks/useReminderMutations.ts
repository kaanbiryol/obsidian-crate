import { useCallback, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import {
	mergeProject,
	reorderProjectReminders,
} from '../reminder-list-state';
import { capturePwaSession } from '../session-generation';
import { discardReminderDraft } from '../reminder-drafts';
import type { ApiFetch, ModalState, ReminderMutationBody, ReminderRecord, ShowToast, StoredConfig } from '../types';

export function useReminderMutations({
	apiFetch,
	beginLocalMutation,
	commitReminderState,
	closeModal,
	config,
	ensureCanMutate,
	projects,
	projectsRef,
	remindersRef,
	selectedProject,
	setReminders,
	setSaving,
	showToast,
}: {
	apiFetch: ApiFetch;
	beginLocalMutation: () => () => void;
	commitReminderState: (reminders: ReminderRecord[], projects?: string[]) => void;
	closeModal: () => void;
	config: StoredConfig;
	ensureCanMutate: () => boolean;
	projects: string[];
	projectsRef: MutableRefObject<string[]>;
	remindersRef: MutableRefObject<ReminderRecord[]>;
	selectedProject: string | null;
	setProjects: Dispatch<SetStateAction<string[]>>;
	setReminders: Dispatch<SetStateAction<ReminderRecord[]>>;
	setSaving: Dispatch<SetStateAction<boolean>>;
	showToast: ShowToast;
}): {
	saveReminder: (currentModal: ModalState) => Promise<void>;
	toggleReminderCompleted: (reminderId: string, completed: boolean) => Promise<void>;
	deleteReminder: (reminderId: string, expectedRevision?: string, filePath?: string) => Promise<void>;
	persistReorder: (project: string, orderedIds: string[]) => Promise<void>;
} {
	const buildMutationBody = useCallback(async (draft: ModalState['draft'], mode: ModalState['mode']) => {
		const { buildReminderMutationBody } = await import('../reminder-mutation');
		return buildReminderMutationBody({
			config: {
				folderPath: config.folderPath,
			},
			draft,
			mode,
			projects,
			selectedProject,
		});
	}, [config.folderPath, projects, selectedProject]);

	// Different records may save together; the same record and project ordering
	// cannot overtake themselves. Only acknowledged state enters the list/cache.
	const pending = useRef(new Set<string>());
	const begin = (id: string) => {
		if (!ensureCanMutate()) return null;
		if (pending.current.has(id) || pending.current.has('*') || (id === '*' && pending.current.size)) {
			showToast('info', 'Wait for the current change to finish');
			return null;
		}
		pending.current.add(id);
		const endMutation = beginLocalMutation();
		return () => { pending.current.delete(id); endMutation(); };
	};
	const merge = (record: ReminderRecord) => {
		const current = remindersRef.current;
		commitReminderState(current.some(item => item.id === record.id)
			? current.map(item => item.id === record.id ? record : item)
			: [...current, record], mergeProject(projectsRef.current, record.project));
	};

	const saveReminder = async (currentModal: ModalState) => {
		const finish = begin(currentModal.reminderId ?? 'new');
		if (!finish) return;
		const sessionCurrent = capturePwaSession();
		setSaving(true);
		try {
			const body: ReminderMutationBody = await buildMutationBody(currentModal.draft, currentModal.mode);
			if (!sessionCurrent()) return;
			if (!body.content.trim()) throw new Error('Reminder title required');
			const { saveReminderCommand } = await import('../save-reminder-command');
			if (!sessionCurrent()) return;
			const result = await saveReminderCommand(currentModal, body, apiFetch, sessionCurrent);
			if (!sessionCurrent()) return;
			if (!result.reminder) throw new Error('The server did not confirm this reminder. Reload before retrying.');
			merge(result.reminder);
			discardReminderDraft(currentModal);
			closeModal();
			showToast(result.notificationWarning ? 'info' : 'success', result.notificationWarning
				? `Saved. Notification sync failed: ${result.notificationWarning}` : 'Reminder saved');
		} catch (error) {
			if (sessionCurrent()) showToast('error', error instanceof Error ? error.message : String(error));
		} finally {
			finish();
			if (sessionCurrent()) setSaving(false);
		}
	};

	const toggleReminderCompleted = async (id: string, completed: boolean) => {
		const finish = begin(id);
		if (!finish) return;
		const sessionCurrent = capturePwaSession();
		const reminder = remindersRef.current.find(item => item.id === id);
		try {
			const response = await apiFetch('/reminders/set-completed', {
				method: 'POST',
				body: JSON.stringify({ folderPath: config.folderPath,
					id, filePath: reminder?.filePath, expectedRevision: reminder?.revision,
					operationId: crypto.randomUUID(), completed: !completed }),
			});
			if (!response.ok) throw new Error(await response.text());
			const result = await response.json() as { reminder?: ReminderRecord; notificationWarning?: string };
			if (!sessionCurrent()) return;
			if (!result.reminder) throw new Error('The server did not confirm this change. Reload before retrying.');
			merge(result.reminder);
			if (result.notificationWarning) showToast('info', `Updated. Notification sync failed: ${result.notificationWarning}`);
		} catch (error) {
			if (sessionCurrent()) showToast('error', error instanceof Error ? error.message : String(error));
		} finally { finish(); }
	};

	const deleteReminder = async (id: string, expectedRevision?: string, filePath?: string) => {
		const finish = begin(id);
		if (!finish) return;
		const sessionCurrent = capturePwaSession();
		const reminder = remindersRef.current.find(item => item.id === id);
		setSaving(true);
		try {
			const response = await apiFetch('/reminders/delete', {
				method: 'DELETE',
				body: JSON.stringify({ folderPath: config.folderPath, id, filePath: filePath ?? reminder?.filePath,
					expectedRevision: expectedRevision ?? reminder?.revision, operationId: crypto.randomUUID() }),
			});
			if (!response.ok) throw new Error(await response.text());
			if (!sessionCurrent()) return;
			commitReminderState(remindersRef.current.filter(item => item.id !== id));
			discardReminderDraft({ mode: 'edit', reminderId: id } as ModalState);
			closeModal();
			showToast('success', 'Reminder deleted');
		} catch (error) {
			if (sessionCurrent()) showToast('error', error instanceof Error ? error.message : String(error));
		} finally { finish(); if (sessionCurrent()) setSaving(false); }
	};

	const persistReorder = async (project: string, orderedIds: string[]) => {
		const finish = begin('*');
		if (!finish) { setReminders(current => [...current]); return; }
		const sessionCurrent = capturePwaSession();
		try {
			const response = await apiFetch('/reminders/reorder', {
				method: 'POST',
				body: JSON.stringify({ folderPath: config.folderPath, project, orderedIds,
					expectedOrder: remindersRef.current.filter(item => item.project === project).map(item => item.id),
					operationId: crypto.randomUUID() }),
			});
			if (!response.ok) throw new Error(await response.text());
			if (sessionCurrent()) commitReminderState(reorderProjectReminders(remindersRef.current, project, orderedIds));
		} catch (error) {
			if (sessionCurrent()) {
				setReminders(current => [...current]);
				showToast('error', error instanceof Error ? error.message : String(error));
			}
		} finally { finish(); }
	};

	return { saveReminder, toggleReminderCompleted, deleteReminder, persistReorder };
}
