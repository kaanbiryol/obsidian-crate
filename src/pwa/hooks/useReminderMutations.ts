import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import {
	applyOptimisticReminderUpdate,
	buildOptimisticReminder,
	mergeProject,
	reorderProjectReminders,
} from '../reminder-list-state';
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
	setProjects,
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
	deleteReminder: (reminderId: string) => Promise<void>;
	persistReorder: (project: string, orderedIds: string[]) => Promise<void>;
} {
	const buildMutationBody = useCallback(async (draft: ModalState['draft'], mode: ModalState['mode']) => {
		const { buildReminderMutationBody } = await import('../reminder-mutation');
		return buildReminderMutationBody({
			config: {
				allDayNotificationTime: config.allDayNotificationTime,
				folderPath: config.folderPath,
			},
			draft,
			mode,
			projects,
			selectedProject,
		});
	}, [config.allDayNotificationTime, config.folderPath, projects, selectedProject]);

	const saveReminder = useCallback(async (currentModal: ModalState) => {
		if (!ensureCanMutate()) return;
		setSaving(true);
		let body: ReminderMutationBody;
		try {
			body = await buildMutationBody(currentModal.draft, currentModal.mode);
		} catch (buildError) {
			setSaving(false);
			showToast('error', buildError instanceof Error ? buildError.message : String(buildError));
			return;
		}
		if (!String(body.content || '').trim()) {
			setSaving(false);
			showToast('error', 'Reminder title required');
			return;
		}

		const endMutation = beginLocalMutation();
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
			if (isEdit) {
				requestBody.filePath = previousReminders.find(reminder => reminder.id === optimisticId)?.filePath;
			}

			const response = await apiFetch(path, {
				method: 'POST',
				body: JSON.stringify(requestBody),
			});
			if (!response.ok) throw new Error(await response.text());
			const result = await response.json() as { reminder?: ReminderRecord; notificationWarning?: string };
			endMutation();
			const committedReminder = result.reminder ?? optimisticReminder;
			const committedReminders = isEdit
				? previousReminders.map((reminder) => reminder.id === optimisticId ? committedReminder : reminder)
				: [...previousReminders, committedReminder];
			commitReminderState(committedReminders, mergeProject(previousProjects, committedReminder.project));
			showToast(result.notificationWarning ? 'info' : 'success', result.notificationWarning
				? `Saved. Notification sync failed: ${result.notificationWarning}`
				: 'Reminder saved');
		} catch (saveError) {
			endMutation();
			setReminders(previousReminders);
			setProjects(previousProjects);
			setSaving(false);
			showToast('error', saveError instanceof Error ? saveError.message : String(saveError));
		}
	}, [apiFetch, beginLocalMutation, buildMutationBody, closeModal, commitReminderState, ensureCanMutate, projectsRef, remindersRef, setProjects, setReminders, setSaving, showToast]);

	const toggleReminderCompleted = useCallback(async (reminderId: string, completed: boolean) => {
		if (!ensureCanMutate()) return;
		const endMutation = beginLocalMutation();
		const previousReminders = remindersRef.current;
		const previousReminder = previousReminders.find((reminder) => reminder.id === reminderId);
		const nextCompleted = !completed;
		setReminders((current) => current.map((reminder) => reminder.id === reminderId
			? { ...reminder, completed: nextCompleted }
			: reminder));
		try {
			const response = await apiFetch('/reminders/set-completed', {
				method: 'POST',
				body: JSON.stringify({
					folderPath: config.folderPath,
					allDayNotificationTime: config.allDayNotificationTime,
					id: reminderId,
					filePath: previousReminder?.filePath,
					completed: nextCompleted,
				}),
			});
			if (!response.ok) throw new Error(await response.text());
			const result = await response.json() as { reminder?: ReminderRecord; notificationWarning?: string };
			endMutation();
			const committedReminders = previousReminders.map((reminder) => reminder.id === reminderId
				? result.reminder ?? { ...reminder, completed: nextCompleted }
				: reminder);
			commitReminderState(committedReminders);
			if (result.notificationWarning) showToast('info', `Updated. Notification sync failed: ${result.notificationWarning}`);
		} catch (toggleError) {
			endMutation();
			if (previousReminder) {
				setReminders((current) => current.map((reminder) => reminder.id === reminderId
					? previousReminder
					: reminder));
			}
			showToast('error', toggleError instanceof Error ? toggleError.message : String(toggleError));
		}
	}, [apiFetch, beginLocalMutation, commitReminderState, config.allDayNotificationTime, config.folderPath, ensureCanMutate, remindersRef, setReminders, showToast]);

	const deleteReminder = useCallback(async (reminderId: string) => {
		if (!ensureCanMutate()) return;
		const endMutation = beginLocalMutation();
		const previousReminders = remindersRef.current;
		const deletedReminder = previousReminders.find(reminder => reminder.id === reminderId);
		setReminders((current) => current.filter((reminder) => reminder.id !== reminderId));
		closeModal();
		try {
			const response = await apiFetch('/reminders/delete', {
				method: 'DELETE',
				body: JSON.stringify({ folderPath: config.folderPath, id: reminderId, filePath: deletedReminder?.filePath }),
			});
			if (!response.ok) throw new Error(await response.text());
			endMutation();
			commitReminderState(previousReminders.filter(reminder => reminder.id !== reminderId));
			showToast('success', 'Reminder deleted');
		} catch (deleteError) {
			endMutation();
			setReminders(previousReminders);
			showToast('error', deleteError instanceof Error ? deleteError.message : String(deleteError));
		}
	}, [apiFetch, beginLocalMutation, closeModal, commitReminderState, config.folderPath, ensureCanMutate, remindersRef, setReminders, showToast]);

	const persistReorder = useCallback(async (project: string, orderedIds: string[]) => {
		if (!ensureCanMutate()) {
			setReminders((current) => [...current]);
			return;
		}
		const endMutation = beginLocalMutation();
		const previousReminders = remindersRef.current;
		setReminders((current) => reorderProjectReminders(current, project, orderedIds));
		try {
			const response = await apiFetch('/reminders/reorder', {
				method: 'POST',
				body: JSON.stringify({ folderPath: config.folderPath, project, orderedIds }),
			});
			if (!response.ok) throw new Error(await response.text());
			endMutation();
			commitReminderState(reorderProjectReminders(previousReminders, project, orderedIds));
		} catch (reorderError) {
			endMutation();
			setReminders(previousReminders);
			showToast('error', reorderError instanceof Error ? reorderError.message : String(reorderError));
		}
	}, [apiFetch, beginLocalMutation, commitReminderState, config.folderPath, ensureCanMutate, remindersRef, setReminders, showToast]);

	return {
		saveReminder,
		toggleReminderCompleted,
		deleteReminder,
		persistReorder,
	};
}
