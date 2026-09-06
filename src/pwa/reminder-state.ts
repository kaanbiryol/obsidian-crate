import {
	applyReminderDraftContentUpdate,
	deriveReminderDraftContentMetadata,
	type ReminderDraftContentMetadata,
} from '@/reminders/core/reminderDraft';
import type { Priority, RecurrenceRule } from '@/reminders/types/reminder';
import { formatDueDate } from '@/reminders/utils/dateFormatting';
import { formatLocalDateKey, parseReminderDateValue } from '@/reminders/utils/reminderDate';
import { normalizeRecurrenceRule } from '@/reminders/utils/recurrenceRule';
import {
	getReminderDateForPreset,
	type ReminderDatePreset,
} from '@/reminders/ui/reminder-modal/datePresets';
import type { ModalDraft } from './types';

export function formatModalDueSummary(draft: ModalDraft): string {
	if (!draft.dueDate) return 'No date';
	return formatDueDate(draft.dueTime ? `${draft.dueDate}T${draft.dueTime}` : draft.dueDate) ?? 'No date';
}

export function hasReminderDraftTitle(
	content: string,
	projectOptions: string[],
	defaultProject: string,
): boolean {
	return Boolean(
		deriveReminderDraftContentMetadata(content, projectOptions, defaultProject).cleanContent.trim(),
	);
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
	const metadata = deriveReminderDraftContentMetadata(
		draft.content,
		projectOptions,
		draft.defaultProject,
	);
	const next = applyReminderDraftContentUpdate(
		{
			content: draft.content,
			dueDate: metadata.dueDate ?? getDraftDueValue(draft),
			recurrence: normalizeRecurrenceRule(metadata.recurrence ?? draft.recurrence),
			project: metadata.hasProject ? metadata.project : (draft.project || draft.defaultProject),
			priority: metadata.hasPriorityMarker ? metadata.priority : draft.priority,
			hasTime: metadata.dueDate ? metadata.hasTime : draftHasTime(draft),
		},
		{
			dueDate: update.dueDateValue,
			hasTime: update.hasTime,
			recurrence: update.recurrence === undefined
				? undefined
				: update.recurrence === null ? null : normalizeRecurrenceRule(update.recurrence),
			project: update.project,
			priority: update.priority,
		},
		projectOptions,
		draft.defaultProject,
	);
	const dateFields = splitDraftDateValue(next.dueDate, next.hasTime);

	return {
		content: next.content,
		project: next.project,
		priority: next.priority,
		recurrence: next.recurrence,
		...dateFields,
		deleteConfirm: false,
	};
}

export function deriveDraftPatchFromContent(
	draft: ModalDraft,
	projectOptions: string[],
	metadata: ReminderDraftContentMetadata = deriveReminderDraftContentMetadata(draft.content, projectOptions, draft.defaultProject),
): Partial<ModalDraft> {
	const patch: Partial<ModalDraft> = {};
	const nextProject = metadata.project;

	if (nextProject !== draft.project) {
		patch.project = nextProject;
	}

	const nextPriority = metadata.priority;
	if (nextPriority !== draft.priority) {
		patch.priority = nextPriority;
	}

	if (metadata.recurrence) {
		const nextRecurrence = normalizeRecurrenceRule(metadata.recurrence);
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

	if (metadata.dueDate) {
		const dateFields = splitDraftDateValue(metadata.dueDate, metadata.hasTime);
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
	preset: ReminderDatePreset | 'clear',
): Partial<ModalDraft> {
	if (preset === 'clear') {
		return applyReminderTextUpdate(draft, projectOptions, { dueDateValue: null, hasTime: false, recurrence: null });
	}

	const next = getReminderDateForPreset(preset);

	return applyReminderTextUpdate(draft, projectOptions, {
		dueDateValue: preset === 'evening' ? next.toISOString() : formatLocalDateKey(next),
		hasTime: preset === 'evening',
		recurrence: null,
	});
}
