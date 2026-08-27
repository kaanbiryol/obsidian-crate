import { format } from 'date-fns';
import type { Priority, Reminder, RecurrenceRule } from '../../types';
import { recurrenceToText } from '../../utils/rruleConverter';
import { parseReminderDateValue } from '../../utils/reminderDate';
import { parseReminderContent } from '../../utils/reminderParser';

export interface ReminderDraftContentState {
	content: string;
	dueDate: string | null;
	recurrence: RecurrenceRule | undefined;
	project: string;
	priority: Priority;
	hasTime: boolean;
}

export interface ReminderDraftContentPatch {
	dueDate?: string | null;
	recurrence?: RecurrenceRule | null;
	project?: string;
	priority?: Priority;
	hasTime?: boolean;
}

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

export function applyReminderDraftContentUpdate(
	current: ReminderDraftContentState,
	patch: ReminderDraftContentPatch,
	projects: string[],
	defaultProject: string,
): ReminderDraftContentState {
	const parsed = parseReminderContent(current.content, projects);
	const cleanText = parsed.cleanContent ?? current.content.trim();
	const next: ReminderDraftContentState = {
		content: current.content,
		dueDate: patch.dueDate !== undefined ? patch.dueDate : current.dueDate,
		recurrence: patch.recurrence !== undefined ? (patch.recurrence ?? undefined) : current.recurrence,
		project: patch.project !== undefined ? patch.project : current.project,
		priority: patch.priority !== undefined ? patch.priority : current.priority,
		hasTime: patch.hasTime !== undefined ? patch.hasTime : current.hasTime,
	};

	next.content = rebuildReminderContent(
		cleanText,
		next.dueDate,
		next.recurrence,
		next.project,
		next.priority,
		defaultProject,
		next.hasTime,
	);
	return next;
}
