import type { Priority, Reminder, RecurrenceRule } from '../types';
import { recurrenceToEditorText } from './recurrence/rruleConverter';
import { formatReminderDateText, parseReminderDateValue, serializeReminderDateValue } from './dates/reminderDate';
import { parseReminderEditorContent } from './grammar/reminderEditorParsing';
import { findProjectMatches } from './grammar/richTextMatchers';
import { normalizeRecurrenceRule, preserveRecurrenceMetadata } from './recurrence/recurrenceRule';
import { DEFAULT_PROJECT } from './constants';

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

export interface ReminderDraftScheduleSource {
	initialContentHadSchedule: boolean;
	dueDateSetFromText: boolean;
	/** PWA drafts store an explicit zone; plugin drafts retain the parsed rule. */
	recurrenceTimezone: 'preserve' | 'local-default';
}

/** Reconcile already-parsed text without re-evaluating relative dates on renders. */
export function reconcileReminderDraftMetadata(
	current: ReminderDraftContentState,
	metadata: ReminderDraftContentMetadata,
	source: ReminderDraftScheduleSource,
): { state: ReminderDraftContentState; dueDateSetFromText: boolean } {
	const preserved = preserveRecurrenceMetadata(metadata.recurrence, current.recurrence);
	const recurrence = source.recurrenceTimezone === 'local-default' ? normalizeRecurrenceRule(preserved) : preserved;
	const state = { ...current, project: metadata.project, priority: metadata.priority, recurrence };
	let dueDateSetFromText = source.dueDateSetFromText;
	if (recurrence) {
		if (recurrence !== current.recurrence) {
			state.dueDate = null;
			state.hasTime = false;
		}
		dueDateSetFromText = false;
	} else if (metadata.dueDate) {
		if (state.dueDate !== metadata.dueDate) dueDateSetFromText = true;
		state.dueDate = metadata.dueDate;
		state.hasTime = metadata.hasTime;
	} else if (state.dueDate && (source.initialContentHadSchedule || dueDateSetFromText)) {
		state.dueDate = null;
		state.hasTime = false;
		dueDateSetFromText = false;
	}
	return { state, dueDateSetFromText };
}

export function getDefaultProject(defaultProject: string): string {
	return defaultProject || DEFAULT_PROJECT;
}

export function deriveReminderDraftContentMetadata(
	content: string,
	projects: string[],
	defaultProject: string,
): ReminderDraftContentMetadata {
	const parsed = parseReminderEditorContent(content, projects);
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
		reconstructed += ` ${recurrenceToEditorText(reminder.recurrence)}`;
	} else {
		const effectiveDate = reminder.dueDatetime || reminder.dueDate || initialDueDate;
		if (effectiveDate) {
			const isDateOnly = !reminder.dueDatetime && !!reminder.dueDate;
			const parsedDate = parseReminderDateValue(effectiveDate, !isDateOnly);
			if (parsedDate) {
				reconstructed += ` ${formatReminderDateText(parsedDate, !isDateOnly)}`;
			}
		}
	}

	const resolvedDefaultProject = getDefaultProject(defaultProject);
	if (
		reminder.project &&
		(reminder.project !== resolvedDefaultProject
			|| findProjectMatches(reminder.content).length > 0)
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
		result += ` ${recurrenceToEditorText(recurrence)}`;
	} else if (date) {
		const parsedDate = parseReminderDateValue(date, hasTime);
		if (parsedDate) {
			result += ` ${formatReminderDateText(parsedDate, hasTime)}`;
		}
	}

	const resolvedDefaultProject = getDefaultProject(defaultProject);
	if (project && (project !== resolvedDefaultProject || findProjectMatches(cleanText).length > 0)) {
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
