import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import {
	applyOptimisticReminderUpdate,
	buildOptimisticReminder,
	mergeProject,
	reorderProjectReminders,
} from '../reminder-state';
import { buildReminderMutationBody } from '../reminder-mutation';
import type { ModalState, ReminderRecord, StoredConfig, ToastKind } from '../types';

type ApiFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function useReminderMutations({
	apiFetch,
	closeModal,
	config,
	ensureCanMutate,
	loadReminders,
	projects,
	projectsRef,
	remindersRef,
	selectedProject,
	setProjects,
	setReminders,
	setSaving,
	showToast,
}: {
	apiFetch: ApiFetch;
	closeModal: () => void;
	config: StoredConfig;
	ensureCanMutate: () => boolean;
	loadReminders: (options?: { silent?: boolean }) => Promise<void>;
	projects: string[];
	projectsRef: MutableRefObject<string[]>;
	remindersRef: MutableRefObject<ReminderRecord[]>;
	selectedProject: string | null;
	setProjects: Dispatch<SetStateAction<string[]>>;
	setReminders: Dispatch<SetStateAction<ReminderRecord[]>>;
	setSaving: Dispatch<SetStateAction<boolean>>;
	showToast: (kind: ToastKind, message: string) => void;
}): {
	saveReminder: (currentModal: ModalState) => Promise<void>;
	toggleReminderCompleted: (reminderId: string, completed: boolean) => Promise<void>;
	deleteReminder: (reminderId: string) => Promise<void>;
	persistReorder: (project: string, orderedIds: string[]) => Promise<void>;
} {
	const buildMutationBody = useCallback((draft: ModalState['draft'], mode: ModalState['mode']) =>
		buildReminderMutationBody({
			config: {
				allDayNotificationTime: config.allDayNotificationTime,
				folderPath: config.folderPath,
			},
			draft,
			mode,
			projects,
			selectedProject,
		}), [config.allDayNotificationTime, config.folderPath, projects, selectedProject]);

	const saveReminder = useCallback(async (currentModal: ModalState) => {
		if (!ensureCanMutate()) return;
		const body = buildMutationBody(currentModal.draft, currentModal.mode);
		if (!String(body.content || '').trim()) {
			showToast('error', 'Reminder title required');
			return;
		}

		setSaving(true);
		const previousReminders = remindersRef.current;
		const previousProjects = projectsRef.current;
		const isEdit = currentModal.mode === 'edit' && Boolean(currentModal.reminderId);
		const optimisticId = currentModal.reminderId ?? crypto.randomUUID();
		const optimisticReminder = buildOptimisticReminder(body, optimisticId);
		const nextProjects = mergeProject(previousProjects, optimisticReminder.project);
		setProjects(nextProjects);
		setReminders((current) => isEdit
			? current.map((reminder) => reminder.id === optimisticId ? applyOptimisticReminderUpdate(reminder, body) : reminder)
			: [...current, optimisticReminder]);
		closeModal();
		try {
			const path = isEdit ? '/reminders/update' : '/reminders/create';
			const requestBody: Record<string, unknown> = { ...body };
			requestBody.id = optimisticId;

			const response = await apiFetch(path, {
				method: 'POST',
				body: JSON.stringify(requestBody),
			});
			if (!response.ok) throw new Error(await response.text());
			const result = await response.json() as { notificationWarning?: string };
			await loadReminders({ silent: true });
			showToast(result.notificationWarning ? 'info' : 'success', result.notificationWarning
				? `Saved. Notification sync failed: ${result.notificationWarning}`
				: 'Reminder saved');
		} catch (saveError) {
			setReminders(previousReminders);
			setProjects(previousProjects);
			showToast('error', saveError instanceof Error ? saveError.message : String(saveError));
		}
	}, [apiFetch, buildMutationBody, closeModal, ensureCanMutate, loadReminders, projectsRef, remindersRef, setProjects, setReminders, setSaving, showToast]);

	const toggleReminderCompleted = useCallback(async (reminderId: string, completed: boolean) => {
		if (!ensureCanMutate()) return;
		const previousReminders = remindersRef.current;
		const nextCompleted = !completed;
		setReminders((current) => current.map((reminder) => reminder.id === reminderId
			? { ...reminder, completed: nextCompleted, updatedAt: new Date().toISOString() }
			: reminder));
		try {
			const response = await apiFetch('/reminders/set-completed', {
				method: 'POST',
				body: JSON.stringify({
					folderPath: config.folderPath,
					allDayNotificationTime: config.allDayNotificationTime,
					id: reminderId,
					completed: nextCompleted,
				}),
			});
			if (!response.ok) throw new Error(await response.text());
			const result = await response.json() as { notificationWarning?: string };
			await loadReminders({ silent: true });
			if (result.notificationWarning) showToast('info', `Updated. Notification sync failed: ${result.notificationWarning}`);
		} catch (toggleError) {
			setReminders(previousReminders);
			showToast('error', toggleError instanceof Error ? toggleError.message : String(toggleError));
		}
	}, [apiFetch, config.allDayNotificationTime, config.folderPath, ensureCanMutate, loadReminders, remindersRef, setReminders, showToast]);

	const deleteReminder = useCallback(async (reminderId: string) => {
		if (!ensureCanMutate()) return;
		const previousReminders = remindersRef.current;
		setReminders((current) => current.filter((reminder) => reminder.id !== reminderId));
		closeModal();
		try {
			const response = await apiFetch('/reminders/delete', {
				method: 'DELETE',
				body: JSON.stringify({ folderPath: config.folderPath, id: reminderId }),
			});
			if (!response.ok) throw new Error(await response.text());
			await loadReminders({ silent: true });
			showToast('success', 'Reminder deleted');
		} catch (deleteError) {
			setReminders(previousReminders);
			showToast('error', deleteError instanceof Error ? deleteError.message : String(deleteError));
		}
	}, [apiFetch, closeModal, config.folderPath, ensureCanMutate, loadReminders, remindersRef, setReminders, showToast]);

	const persistReorder = useCallback(async (project: string, orderedIds: string[]) => {
		if (!ensureCanMutate()) {
			setReminders((current) => [...current]);
			return;
		}
		const previousReminders = remindersRef.current;
		setReminders((current) => reorderProjectReminders(current, project, orderedIds));
		try {
			const response = await apiFetch('/reminders/reorder', {
				method: 'POST',
				body: JSON.stringify({ folderPath: config.folderPath, project, orderedIds }),
			});
			if (!response.ok) throw new Error(await response.text());
			await loadReminders({ silent: true });
		} catch (reorderError) {
			setReminders(previousReminders);
			showToast('error', reorderError instanceof Error ? reorderError.message : String(reorderError));
		}
	}, [apiFetch, config.folderPath, ensureCanMutate, loadReminders, remindersRef, setReminders, showToast]);

	return {
		saveReminder,
		toggleReminderCompleted,
		deleteReminder,
		persistReorder,
	};
}
