import { format } from 'date-fns';
import type { Priority, Reminder, RecurrenceRule } from '../types';
import { recurrenceToText } from '../utils/rruleConverter';
import { parseReminderDateValue, serializeReminderDateValue } from '../utils/reminderDate';
import { parseReminderContent } from '../utils/reminderParser';

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

export interface ReminderDraftContentMetadata {
	cleanContent: string;
	dueDate: string | null;
	hasDate: boolean;
	recurrence: RecurrenceRule | undefined;
	project: string;
	hasProject: boolean;
	priority: Priority;
	hasPriorityMarker: boolean;
	hasTime: boolean;
}

export function getDefaultProject(defaultProject: string): string {
	return defaultProject || 'Inbox';
}

export function deriveReminderDraftContentMetadata(
	content: string,
	projects: string[],
	defaultProject: string,
): ReminderDraftContentMetadata {
	const parsed = parseReminderContent(content, projects);
	const recurrence = parsed.recurrence;
	const hasTime = !recurrence && Boolean(parsed.dueDate && parsed.hasTime);
	const dueDate = !recurrence && parsed.dueDate
		? (serializeReminderDateValue(parsed.dueDate, hasTime) ?? null)
		: null;

	return {
		cleanContent: parsed.cleanContent ?? content.trim(),
		dueDate,
		hasDate: parsed.dueDate !== undefined,
		recurrence,
		project: parsed.project ?? getDefaultProject(defaultProject),
		hasProject: parsed.project !== undefined,
		priority: parsed.priorityPart ? parsed.priority : 4,
		hasPriorityMarker: Boolean(parsed.priorityPart),
		hasTime,
	};
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
	const metadata = deriveReminderDraftContentMetadata(current.content, projects, defaultProject);
	const next: ReminderDraftContentState = {
		content: current.content,
		dueDate: patch.dueDate !== undefined ? patch.dueDate : current.dueDate,
		recurrence: patch.recurrence !== undefined ? (patch.recurrence ?? undefined) : current.recurrence,
		project: patch.project !== undefined ? patch.project : current.project,
		priority: patch.priority !== undefined ? patch.priority : current.priority,
		hasTime: patch.hasTime !== undefined ? patch.hasTime : current.hasTime,
	};

	if (patch.recurrence) {
		next.dueDate = null;
		next.hasTime = false;
	} else if (patch.dueDate !== undefined) {
		next.recurrence = undefined;
		if (!patch.dueDate) next.hasTime = false;
	}

	next.content = rebuildReminderContent(
		metadata.cleanContent,
		next.dueDate,
		next.recurrence,
		next.project,
		next.priority,
		defaultProject,
		next.hasTime,
	);
	return next;
}
