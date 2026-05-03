import {
	buildInitialReminderContent,
	rebuildReminderContent,
} from '@/reminders/components/addReminderModal/useReminderDraft';
import type { Priority, Reminder as SharedReminder, RecurrenceRule } from '@/reminders/types/reminder';
import { formatDueDate } from '@/reminders/utils/dateFormatting';
import { formatLocalDateKey, parseReminderDateValue, serializeReminderDateValue } from '@/reminders/utils/reminderDate';
import { parseReminderContent } from '@/reminders/utils/reminderParser';
import { normalizeRecurrenceRule } from '@/reminders/utils/recurrenceRule';
import type { ModalDraft, ReminderMutationBody, ReminderRecord } from './types';

export function toSharedReminder(reminder: ReminderRecord): SharedReminder {
	const timestamp = reminder.updatedAt ?? reminder.createdAt ?? new Date(0).toISOString();
	return {
		id: reminder.id,
		content: reminder.content,
		description: reminder.description,
		dueDate: reminder.dueDate,
		dueDatetime: reminder.dueDatetime,
		priority: reminder.priority,
		completed: reminder.completed,
		project: reminder.project || 'Inbox',
		recurrence: reminder.recurrence,
		fileLink: reminder.filePath,
		lineNumber: reminder.lineNumber,
		createdAt: reminder.createdAt ?? timestamp,
		updatedAt: timestamp,
	};
}

export function buildOptimisticReminder(body: ReminderMutationBody, id: string): ReminderRecord {
	const project = body.project.trim() || 'Inbox';
	const timestamp = new Date().toISOString();
	return {
		id,
		content: body.content,
		description: body.description?.trim() || undefined,
		dueDate: body.dueDate || undefined,
		dueDatetime: body.dueDatetime || undefined,
		priority: body.priority,
		completed: false,
		project,
		recurrence: normalizeRecurrenceRule(body.recurrence ?? undefined),
		filePath: `${body.folderPath}/${project}.md`,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

export function applyOptimisticReminderUpdate(reminder: ReminderRecord, body: ReminderMutationBody): ReminderRecord {
	const project = body.project.trim() || reminder.project || 'Inbox';
	return {
		...reminder,
		content: body.content,
		description: body.description?.trim() || undefined,
		dueDate: body.dueDate || undefined,
		dueDatetime: body.dueDatetime || undefined,
		priority: body.priority,
		project,
		recurrence: Object.prototype.hasOwnProperty.call(body, 'recurrence')
			? normalizeRecurrenceRule(body.recurrence ?? undefined)
			: reminder.recurrence,
		filePath: project === reminder.project ? reminder.filePath : `${body.folderPath}/${project}.md`,
		updatedAt: new Date().toISOString(),
	};
}

export function reorderProjectReminders(reminders: ReminderRecord[], project: string, orderedIds: string[]): ReminderRecord[] {
	const order = new Map(orderedIds.map((id, index) => [id, index]));
	const activeProjectReminders = reminders
		.filter((reminder) => reminder.project === project && !reminder.completed)
		.sort((a, b) => {
			const aIndex = order.get(a.id) ?? Number.MAX_SAFE_INTEGER;
			const bIndex = order.get(b.id) ?? Number.MAX_SAFE_INTEGER;
			return aIndex - bIndex;
		});

	let activeIndex = 0;
	return reminders.map((reminder) => {
		if (reminder.project !== project || reminder.completed) return reminder;
		const nextReminder = activeProjectReminders[activeIndex];
		activeIndex += 1;
		return nextReminder ?? reminder;
	});
}

export function mergeProject(projects: string[], project: string): string[] {
	const normalized = project.trim() || 'Inbox';
	return projects.includes(normalized) ? projects : [...projects, normalized].sort((a, b) => a.localeCompare(b));
}

export function buildModalDraft(reminder: ReminderRecord | null, selectedProject: string | null): ModalDraft {
	const parsedDate = reminder?.dueDatetime
		? new Date(reminder.dueDatetime)
		: reminder?.dueDate
			? parseReminderDateValue(reminder.dueDate, false) ?? null
			: null;
	const defaultProject = selectedProject ?? 'Inbox';
	const sharedReminder = reminder ? toSharedReminder(reminder) : undefined;

	return {
		content: buildInitialReminderContent(sharedReminder, defaultProject),
		description: reminder?.description ?? '',
		project: reminder?.project ?? defaultProject,
		defaultProject,
		priority: reminder?.priority ?? 4,
		dueDate: parsedDate && !reminder?.recurrence ? formatLocalDateKey(parsedDate) : '',
		dueTime: reminder?.dueDatetime && !reminder?.recurrence
			? `${String(parsedDate?.getHours() ?? 0).padStart(2, '0')}:${String(parsedDate?.getMinutes() ?? 0).padStart(2, '0')}`
			: '',
		recurrence: reminder?.recurrence,
		activePicker: null,
		deleteConfirm: false,
	};
}

export function formatModalDueSummary(draft: ModalDraft): string {
	if (!draft.dueDate) return 'No date';
	return formatDueDate(draft.dueTime ? `${draft.dueDate}T${draft.dueTime}` : draft.dueDate) ?? 'No date';
}

function getDraftDueValue(draft: ModalDraft): string | null {
	if (!draft.dueDate) return null;
	if (!draft.dueTime) return draft.dueDate;
	const date = new Date(`${draft.dueDate}T${draft.dueTime}`);
	return Number.isNaN(date.getTime()) ? draft.dueDate : date.toISOString();
}

function draftHasTime(draft: Pick<ModalDraft, 'dueDate' | 'dueTime'>): boolean {
	return Boolean(draft.dueDate && draft.dueTime);
}

function splitDraftDateValue(dateValue: string | null | undefined, hasTime: boolean): Pick<ModalDraft, 'dueDate' | 'dueTime'> {
	if (!dateValue) return { dueDate: '', dueTime: '' };
	const parsedDate = parseReminderDateValue(dateValue, hasTime);
	if (!parsedDate || Number.isNaN(parsedDate.getTime())) return { dueDate: '', dueTime: '' };
	return {
		dueDate: formatLocalDateKey(parsedDate),
		dueTime: hasTime
			? `${String(parsedDate.getHours()).padStart(2, '0')}:${String(parsedDate.getMinutes()).padStart(2, '0')}`
			: '',
	};
}

export type ReminderTextUpdate = {
	dueDateValue?: string | null;
	hasTime?: boolean;
	recurrence?: RecurrenceRule | null;
	project?: string;
	priority?: Priority;
};

export function applyReminderTextUpdate(
	draft: ModalDraft,
	projectOptions: string[],
	update: ReminderTextUpdate,
): Partial<ModalDraft> {
	const parsed = parseReminderContent(draft.content, projectOptions);
	const cleanText = parsed.cleanContent?.trim() ?? draft.content.trim();
	const parsedDateValue = parsed.dueDate
		? serializeReminderDateValue(parsed.dueDate, parsed.hasTime)
		: undefined;
	const hasDueDateUpdate = Object.prototype.hasOwnProperty.call(update, 'dueDateValue');
	const hasRecurrenceUpdate = Object.prototype.hasOwnProperty.call(update, 'recurrence');
	let nextDueDateValue = hasDueDateUpdate
		? update.dueDateValue ?? null
		: parsedDateValue ?? getDraftDueValue(draft);
	let nextHasTime = Object.prototype.hasOwnProperty.call(update, 'hasTime')
		? Boolean(update.hasTime)
		: parsed.dueDate
			? Boolean(parsed.hasTime)
			: draftHasTime(draft);
	let nextRecurrence = hasRecurrenceUpdate
		? normalizeRecurrenceRule(update.recurrence ?? undefined)
		: normalizeRecurrenceRule(parsed.recurrence ?? draft.recurrence);

	if (hasRecurrenceUpdate && nextRecurrence) {
		nextDueDateValue = null;
		nextHasTime = false;
	} else if (hasDueDateUpdate) {
		nextRecurrence = undefined;
		if (!nextDueDateValue) nextHasTime = false;
	}

	const nextProject = update.project ?? parsed.project ?? draft.project ?? draft.defaultProject;
	const nextPriority = update.priority ?? (parsed.priorityPart ? parsed.priority : draft.priority);
	const dateFields = splitDraftDateValue(nextDueDateValue, nextHasTime);

	return {
		content: rebuildReminderContent(
			cleanText,
			nextDueDateValue,
			nextRecurrence,
			nextProject,
			nextPriority,
			draft.defaultProject,
			nextHasTime,
		),
		project: nextProject,
		priority: nextPriority,
		recurrence: nextRecurrence,
		...dateFields,
		deleteConfirm: false,
	};
}

export function deriveDraftPatchFromContent(draft: ModalDraft, projectOptions: string[]): Partial<ModalDraft> {
	const parsed = parseReminderContent(draft.content, projectOptions);
	const patch: Partial<ModalDraft> = {};
	const nextProject = parsed.project ?? draft.defaultProject;

	if (nextProject !== draft.project) {
		patch.project = nextProject;
	}

	const nextPriority = parsed.priorityPart ? parsed.priority : 4;
	if (nextPriority !== draft.priority) {
		patch.priority = nextPriority;
	}

	if (parsed.recurrence) {
		const nextRecurrence = normalizeRecurrenceRule(parsed.recurrence);
		if (JSON.stringify(nextRecurrence) !== JSON.stringify(draft.recurrence)) {
			patch.recurrence = nextRecurrence;
		}
		if (draft.dueDate || draft.dueTime) {
			patch.dueDate = '';
			patch.dueTime = '';
		}
		return patch;
	}

	if (draft.recurrence) {
		patch.recurrence = undefined;
	}

	if (parsed.dueDate) {
		const hasTime = Boolean(parsed.hasTime);
		const serialized = serializeReminderDateValue(parsed.dueDate, hasTime);
		const dateFields = splitDraftDateValue(serialized, hasTime);
		if (dateFields.dueDate !== draft.dueDate) patch.dueDate = dateFields.dueDate;
		if (dateFields.dueTime !== draft.dueTime) patch.dueTime = dateFields.dueTime;
		return patch;
	}

	if (draft.dueDate || draft.dueTime) {
		patch.dueDate = '';
		patch.dueTime = '';
	}

	return patch;
}

export function applyDateFieldsToDraft(
	draft: ModalDraft,
	projectOptions: string[],
	dueDate: string,
	dueTime: string,
): Partial<ModalDraft> {
	if (!dueDate) {
		return applyReminderTextUpdate(draft, projectOptions, { dueDateValue: null, hasTime: false, recurrence: null });
	}
	const hasTime = Boolean(dueTime);
	const dateValue = hasTime ? new Date(`${dueDate}T${dueTime}`).toISOString() : dueDate;
	return applyReminderTextUpdate(draft, projectOptions, { dueDateValue: dateValue, hasTime, recurrence: null });
}

export function applyDatePresetToDraft(
	draft: ModalDraft,
	projectOptions: string[],
	preset: 'today' | 'tomorrow' | 'evening' | 'next-week' | 'clear',
): Partial<ModalDraft> {
	if (preset === 'clear') {
		return applyReminderTextUpdate(draft, projectOptions, { dueDateValue: null, hasTime: false, recurrence: null });
	}

	const next = new Date();
	if (preset === 'tomorrow') {
		next.setDate(next.getDate() + 1);
		next.setHours(0, 0, 0, 0);
	} else if (preset === 'evening') {
		if (next.getHours() >= 18) next.setDate(next.getDate() + 1);
		next.setHours(18, 0, 0, 0);
	} else if (preset === 'next-week') {
		next.setDate(next.getDate() + 7);
		next.setHours(0, 0, 0, 0);
	} else {
		next.setHours(0, 0, 0, 0);
	}

	return applyReminderTextUpdate(draft, projectOptions, {
		dueDateValue: preset === 'evening' ? next.toISOString() : formatLocalDateKey(next),
		hasTime: preset === 'evening',
		recurrence: null,
	});
}
