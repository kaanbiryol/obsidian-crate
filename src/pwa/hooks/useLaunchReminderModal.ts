import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type {
	DataMode,
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
	openReminder,
	setSelectedProject,
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
	openReminder: (mode: 'edit', reminder: ReminderRecord, project: string | null, synchronous?: boolean) => void;
	setSelectedProject: Dispatch<SetStateAction<string | null>>;
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

		openReminder('edit', reminder, reminder.project || selectedProject, false);
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
		openReminder,
		setSelectedProject,
		showToast,
	]);
}
