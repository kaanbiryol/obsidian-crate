import { format } from 'date-fns';
import type { Reminder, RecurrenceRule } from '../../types';
import { recurrenceToText } from '../../utils/rruleConverter';
import { parseReminderDateValue } from '../../utils/reminderDate';

export function getDefaultProject(defaultProject: string): string {
	return defaultProject || 'Inbox';
}

export function buildInitialReminderContent(
	reminder: Reminder | undefined,
	defaultProject: string,
	initialDueDate?: string,
): string {
	if (!reminder) {
		return '';
	}

	let reconstructed = reminder.content || '';
	if (reminder.recurrence) {
		reconstructed += ` ${recurrenceToText(reminder.recurrence)}`;
	} else {
		const effectiveDate = reminder.dueDatetime || reminder.dueDate || initialDueDate;
		if (effectiveDate) {
			const isDateOnly = !reminder.dueDatetime && !!reminder.dueDate;
			const fmt = isDateOnly ? 'MMM d, yyyy' : 'MMM d, yyyy HH:mm';
			const parsedDate = parseReminderDateValue(effectiveDate, !isDateOnly);
			if (parsedDate) {
				reconstructed += ` ${format(parsedDate, fmt)}`;
			}
		}
	}

	const resolvedDefaultProject = getDefaultProject(defaultProject);
	if (
		reminder.project &&
		reminder.project !== resolvedDefaultProject &&
		reminder.project !== 'Inbox'
	) {
		reconstructed += ` #${reminder.project}`;
	}

	if (reminder.priority === 1) {
		reconstructed += ' !';
	}

	return reconstructed.trim();
}

export function rebuildReminderContent(
	cleanText: string,
	date: string | null,
	recurrence: RecurrenceRule | undefined,
	project: string,
	priority: number,
	defaultProject: string,
	hasTime?: boolean,
): string {
	let result = cleanText.trim();

	if (recurrence) {
		result += ` ${recurrenceToText(recurrence)}`;
	} else if (date) {
		const fmt = hasTime ? 'MMM d, yyyy HH:mm' : 'MMM d, yyyy';
		const parsedDate = parseReminderDateValue(date, hasTime);
		if (parsedDate) {
			result += ` ${format(parsedDate, fmt)}`;
		}
	}

	const resolvedDefaultProject = getDefaultProject(defaultProject);
	if (project && project !== resolvedDefaultProject && project !== 'Inbox') {
		result += ` #${project}`;
	}

	if (priority === 1) {
		result += ' !';
	}

	return `${result} `;
}
