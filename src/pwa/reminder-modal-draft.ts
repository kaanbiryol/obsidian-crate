import { formatLocalDateKey, parseReminderDateValue } from '@/reminders/utils/reminderDate';
import { recurrenceToText } from '@/reminders/utils/rruleConverter';
import type { ModalDraft, ReminderRecord } from './types';

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function buildInitialModalContent(reminder: ReminderRecord | null, defaultProject: string): string {
	if (!reminder) return '';
	let content = reminder.content || '';
	if (reminder.recurrence) {
		content += ` ${recurrenceToText(reminder.recurrence)}`;
	} else {
		const dueValue = reminder.dueDatetime || reminder.dueDate;
		const hasTime = Boolean(reminder.dueDatetime);
		const due = dueValue ? parseReminderDateValue(dueValue, hasTime) : null;
		if (due) {
			content += ` ${MONTH_LABELS[due.getMonth()]} ${due.getDate()}, ${due.getFullYear()}`;
			if (hasTime) {
				content += ` ${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`;
			}
		}
	}
	if (reminder.project && reminder.project !== defaultProject && reminder.project !== 'Inbox') {
		content += ` #${reminder.project}`;
	}
	if (reminder.priority === 1) content += ' !';
	return content.trim();
}

export function buildModalDraft(reminder: ReminderRecord | null, selectedProject: string | null): ModalDraft {
	const parsedDate = reminder?.dueDatetime
		? new Date(reminder.dueDatetime)
		: reminder?.dueDate
			? parseReminderDateValue(reminder.dueDate, false) ?? null
			: null;
	const defaultProject = selectedProject ?? 'Inbox';

	return {
    originalDueDatetime: reminder?.dueDatetime,
		content: buildInitialModalContent(reminder, defaultProject),
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
