import { formatLocalDateKey, parseReminderDateValue } from '@/reminders/utils/reminderDate';
import { buildInitialReminderContent } from '@/reminders/core/reminderDraft';
import type { ModalDraft, ReminderRecord } from './types';

export function buildModalDraft(reminder: ReminderRecord | null, selectedProject: string | null): ModalDraft {
	const parsedDate = reminder?.dueDatetime
		? new Date(reminder.dueDatetime)
		: reminder?.dueDate
			? parseReminderDateValue(reminder.dueDate, false) ?? null
			: null;
	const defaultProject = selectedProject ?? 'Inbox';

	return {
    originalDueDatetime: reminder?.dueDatetime,
		content: buildInitialReminderContent(reminder ?? undefined, defaultProject),
		description: reminder?.description ?? '',
		project: reminder?.project ?? defaultProject,
		defaultProject,
		priority: reminder?.priority ?? 4,
		dueDate: parsedDate ? formatLocalDateKey(parsedDate) : '',
		dueTime: reminder?.dueDatetime
			? `${String(parsedDate?.getHours() ?? 0).padStart(2, '0')}:${String(parsedDate?.getMinutes() ?? 0).padStart(2, '0')}`
			: '',
		recurrence: reminder?.recurrence,
		activePicker: null,
		deleteConfirm: false,
	};
}
