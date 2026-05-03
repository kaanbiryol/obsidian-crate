import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { buildModalDraft } from '../reminder-state';
import type {
	DataMode,
	ModalState,
	ReminderRecord,
} from '../types';

export function useLaunchReminderModal({
	authToken,
	bootstrapped,
	dataMode,
	isOffline,
	launchReminderId,
	loading,
	readOnlyMessage,
	refreshing,
	reminders,
	selectedProject,
	setLaunchReminderId,
	setModal,
	setSaving,
	setSelectedProject,
	setSettingsOpen,
	showToast,
}: {
	authToken: string | null;
	bootstrapped: boolean;
	dataMode: DataMode;
	isOffline: boolean;
	launchReminderId: string | null;
	loading: boolean;
	readOnlyMessage: string | null;
	refreshing: boolean;
	reminders: ReminderRecord[];
	selectedProject: string | null;
	setLaunchReminderId: Dispatch<SetStateAction<string | null>>;
	setModal: Dispatch<SetStateAction<ModalState | null>>;
	setSaving: Dispatch<SetStateAction<boolean>>;
	setSelectedProject: Dispatch<SetStateAction<string | null>>;
	setSettingsOpen: Dispatch<SetStateAction<boolean>>;
	showToast: (kind: 'info' | 'success' | 'error', message: string) => void;
}): void {
	useEffect(() => {
		if (!launchReminderId || !bootstrapped || !authToken || loading) return;
		if (!isOffline && dataMode === 'cached' && refreshing) return;

		const reminder = reminders.find((item) => item.id === launchReminderId);
		if (!reminder) {
			if (!refreshing) {
				showToast('info', 'Reminder no longer exists');
				setLaunchReminderId(null);
			}
			return;
		}

		setSelectedProject(reminder.project || null);
		if (readOnlyMessage) {
			showToast('info', readOnlyMessage);
			setLaunchReminderId(null);
			return;
		}

		setSettingsOpen(false);
		setSaving(false);
		setModal({
			mode: 'edit',
			reminderId: reminder.id,
			draft: buildModalDraft(reminder, reminder.project || selectedProject),
		});
		setLaunchReminderId(null);
	}, [
		authToken,
		bootstrapped,
		dataMode,
		isOffline,
		launchReminderId,
		loading,
		readOnlyMessage,
		refreshing,
		reminders,
		selectedProject,
		setLaunchReminderId,
		setModal,
		setSaving,
		setSelectedProject,
		setSettingsOpen,
		showToast,
	]);
}
