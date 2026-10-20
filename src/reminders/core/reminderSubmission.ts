import type { Priority, RecurrenceRule } from '../types/reminder';
import { preserveReminderInstant } from './preserveReminderInstant';
import { buildStoredReminderDates, parseReminderDateValue, serializeReminderDateValue } from './dates/reminderDate';
import { normalizeRecurrenceRule, preserveRecurrenceMetadata } from './recurrence/recurrenceRule';
import { parseReminderContent } from './grammar/reminderParser';

interface ReminderSubmissionDraft {
	content: string;
	description?: string;
	projects: string[];
	project: string;
	priority: Priority;
	dueDate: string | null;
	hasTime?: boolean;
	recurrence?: RecurrenceRule;
	mode: 'create' | 'edit';
	originalDueDatetime?: string;
}

/** Resolve the latest editor text before either host serializes a save. */
export function resolveReminderSubmission(draft: ReminderSubmissionDraft) {
	if (!draft.content.trim()) return null;
	const parsed = parseReminderContent(draft.content, draft.projects);
	if (parsed.dateError) throw new Error(parsed.dateError);
	const content = parsed.cleanContent.trim();
	if (!content) return null;

	// Pickers encode the rule in the title. Its absence is a removal even when
	// React has not reconciled the previous draft fields yet.
	const chosenRecurrence = preserveRecurrenceMetadata(parsed.recurrence, draft.recurrence);
	const recurrence = normalizeRecurrenceRule(chosenRecurrence);
	let dateSource: 'text' | 'draft' | 'none' = 'none';
	if (recurrence) {
		// An existing occurrence belongs only to the unchanged repeat rule.
		if (draft.mode === 'edit' && chosenRecurrence === draft.recurrence && draft.dueDate) dateSource = 'draft';
	} else if (parsed.dueDate) {
		dateSource = 'text';
	} else if (!draft.recurrence && draft.dueDate) {
		dateSource = 'draft';
	}
	const dueDateValue = dateSource === 'text'
		? serializeReminderDateValue(parsed.dueDate, parsed.hasTime)
		: dateSource === 'draft' ? draft.dueDate ?? undefined : undefined;
	const hasTime = recurrence ? Boolean(dueDateValue && draft.hasTime)
		: parsed.dueDate ? (parsed.hasTime ?? false) : (draft.hasTime ?? false);
	const storedDates = buildStoredReminderDates(parseReminderDateValue(dueDateValue, hasTime), hasTime);

	return {
		content,
		description: draft.description?.trim() || undefined,
		project: parsed.project || draft.project,
		priority: parsed.priorityPart ? parsed.priority : draft.priority,
		recurrence,
		dueDateValue,
		hasTime,
		dateSource,
		dueDate: storedDates.dueDate,
		dueDatetime: draft.mode === 'edit'
			? preserveReminderInstant(storedDates.dueDatetime, draft.originalDueDatetime, dateSource === 'text')
			: storedDates.dueDatetime,
	};
}
