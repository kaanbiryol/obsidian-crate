import { anchorRecurrence, recurrenceCalendarDate } from './recurrence/recurrenceCalendar';
import type { Priority, RecurrenceRule } from '@/reminders/types/reminder';
import { parseCheckboxLine, rebuildCheckboxLine } from '@/reminders/core/grammar/checkboxParser';
import { UnresolvedReminderScheduleError } from '@/reminders/core/grammar/reminderParser';
import { calculateFirstOccurrence } from '@/reminders/core/recurrence/recurrenceCalculator';
import {
	buildStoredReminderDates,
	inferHasTimeFromDate,
	parseStoredReminderDate,
	reminderHasTime,
} from '@/reminders/core/dates/reminderDate';
import { normalizeRecurrenceRule } from '@/reminders/core/recurrence/recurrenceRule';
import {
	appendReminderBlockToContent,
	replaceReminderBlockInContent,
	type ReminderLineRecord,
} from './markdownReminderFile';
import { buildDescriptionBlock } from './reminderDescription';
import { ReminderInputError } from './reminderMutationInput';

export interface MarkdownReminderRecord extends ReminderLineRecord {
	description?: string;
	project?: string;
	filePath: string;
}

export interface MarkdownReminderUpdate {
	content?: string;
	description?: string;
	dueDate?: Date;
	priority?: Priority;
	recurrence?: RecurrenceRule | null;
	hasTime?: boolean;
}

export interface ReminderBlockMutation {
	checkboxLine: string;
	content: string;
	description?: string;
	dueDate: Date | undefined;
	dueDateKey?: string;
	dueDatetime?: string;
	hasTime: boolean | undefined;
	priority: Priority;
	recurrence: RecurrenceRule | undefined;
}

/** The reminder record fields a block mutation writes. */
export function reminderBlockFields(mutation: ReminderBlockMutation): {
	content: string;
	description: string | undefined;
	dueDate: string | undefined;
	dueDatetime: string | undefined;
	priority: Priority;
	recurrence: RecurrenceRule | undefined;
} {
	return {
		content: mutation.content,
		description: mutation.description,
		dueDate: mutation.dueDateKey,
		dueDatetime: mutation.dueDatetime,
		priority: mutation.priority,
		recurrence: mutation.recurrence,
	};
}

/** A written line that no longer reads as its reminder would hide it in the note. */
export function unreadableReminderTitle(): ReminderInputError {
	return new ReminderInputError('content', 'This title cannot be saved as a reminder. Remove date, time, repeat or priority text from it.');
}

/** Every host reads the line back before writing it. A title ending in a time, such
 * as "Lunch at 1pm", can join the written date into a schedule the saved-line parser
 * reads differently or rejects, which disables every reminder in the note. */
function assertReadsBack(mutation: ReminderBlockMutation): ReminderBlockMutation {
	let parsed;
	try { parsed = parseCheckboxLine(mutation.checkboxLine, { persisted: true })?.parsed; }
	catch (error) {
		if (error instanceof UnresolvedReminderScheduleError) throw unreadableReminderTitle();
		throw error;
	}
	const dates = buildStoredReminderDates(parsed?.dueDate, parsed?.hasTime);
	if (parsed?.cleanContent !== mutation.content.replace(/\s+/g, ' ').trim()
		|| dates.dueDate !== mutation.dueDateKey || dates.dueDatetime !== mutation.dueDatetime) throw unreadableReminderTitle();
	return mutation;
}

/** Date-only dues are written as text ("Oct 30, 2026"), which after a number range can
 * read as part of a schedule. The ISO date that schedule normalization writes may still
 * read back, so it is the fallback before refusing the title. */
function readableBlock(mutation: Omit<ReminderBlockMutation, 'checkboxLine'>, line: (isoDate: boolean) => string): ReminderBlockMutation {
	try { return assertReadsBack({ ...mutation, checkboxLine: line(false) }); }
	catch (error) {
		if (!(error instanceof ReminderInputError) || !mutation.dueDate || mutation.hasTime) throw error;
		return assertReadsBack({ ...mutation, checkboxLine: line(true) });
	}
}

export function buildCreatedReminderBlock(params: {
	content: string;
	description?: string;
	dueDate: Date | undefined;
	priority: Priority;
	recurrence?: RecurrenceRule;
	hasTime?: boolean;
	completed?: boolean;
	reminderId: string;
}): ReminderBlockMutation {
	const rule = normalizeRecurrenceRule(params.recurrence);
	let dueDate = rule && !params.dueDate
		? calculateFirstOccurrence(rule)
		: params.dueDate;
	const hasTime = params.hasTime ?? (rule && !params.dueDate ? rule.hour !== undefined : inferHasTimeFromDate(dueDate));
	if (rule && !params.dueDate && dueDate && !hasTime) dueDate = recurrenceCalendarDate(dueDate, rule);
	const recurrence = rule && dueDate ? anchorRecurrence(rule, dueDate, hasTime) : rule;
	const storedDates = buildStoredReminderDates(dueDate, hasTime);
	return readableBlock({
		content: params.content,
		description: params.description?.trim() || undefined,
		dueDate,
		dueDateKey: storedDates.dueDate,
		dueDatetime: storedDates.dueDatetime,
		hasTime,
		priority: params.priority,
		recurrence,
	}, isoDate => rebuildCheckboxLine({ completed: params.completed ?? false, content: params.content, dueDate, priority: params.priority, recurrence, hasTime, reminderId: params.reminderId, isoDate }));
}

export function appendCreatedReminderBlock(
	fileContent: string,
	mutation: ReminderBlockMutation,
): string {
	return appendReminderBlockToContent(
		fileContent,
		mutation.checkboxLine,
		mutation.description,
	);
}

export function buildUpdatedReminderBlock(
	reminder: MarkdownReminderRecord,
	updates: MarkdownReminderUpdate,
): ReminderBlockMutation {
	const currentDueDate = parseStoredReminderDate(reminder);
	const currentHasTime = reminderHasTime(reminder);
	let recurrence = Object.prototype.hasOwnProperty.call(updates, 'recurrence')
		? normalizeRecurrenceRule(updates.recurrence ?? undefined)
		: normalizeRecurrenceRule(reminder.recurrence);
	let hasTime = Object.prototype.hasOwnProperty.call(updates, 'hasTime')
		? updates.hasTime
		: ('dueDate' in updates ? inferHasTimeFromDate(updates.dueDate) : currentHasTime);
	const content = updates.content ?? reminder.content;
	let dueDate = 'dueDate' in updates ? updates.dueDate : currentDueDate;
	if (recurrence && !dueDate) {
		hasTime = recurrence.hour !== undefined;
		dueDate = calculateFirstOccurrence(recurrence);
		if (!hasTime) dueDate = recurrenceCalendarDate(dueDate, recurrence);
	}
	if (recurrence && dueDate) recurrence = anchorRecurrence(recurrence, dueDate, hasTime);
	const priority = updates.priority ?? reminder.priority;
	const description = 'description' in updates
		? (updates.description?.trim() || undefined)
		: reminder.description;
	const indentation = reminder.rawLine.match(/^(\s*)/)?.[1] ?? '';
	const storedDates = buildStoredReminderDates(dueDate, hasTime);

	return readableBlock({
		content,
		description,
		dueDate,
		dueDateKey: storedDates.dueDate,
		dueDatetime: storedDates.dueDatetime,
		hasTime,
		priority,
		recurrence,
	}, isoDate => rebuildCheckboxLine({ indentation, completed: reminder.completed, content, dueDate, priority, recurrence, hasTime, reminderId: reminder.id, isoDate }));
}

/** A project move writes the edited reminder as a new block in the destination
 * note, keeping its identity and completion state. */
export function buildMovedReminderBlock(
	reminder: MarkdownReminderRecord,
	updates: MarkdownReminderUpdate,
): ReminderBlockMutation {
	const mutation = buildUpdatedReminderBlock(reminder, updates);
	return buildCreatedReminderBlock({
		content: mutation.content,
		description: mutation.description,
		dueDate: mutation.dueDate,
		priority: mutation.priority,
		recurrence: mutation.recurrence,
		hasTime: mutation.hasTime,
		completed: reminder.completed,
		reminderId: reminder.id,
	});
}

export function replaceUpdatedReminderBlock(
	fileContent: string,
	reminder: MarkdownReminderRecord,
	mutation: ReminderBlockMutation,
): { content: string; lineNumber: number } {
	const replacement = replaceReminderBlockInContent(
		fileContent,
		reminder,
		[mutation.checkboxLine, ...buildDescriptionBlock(mutation.description)],
	);
	if (!replacement.found) {
		throw new Error(
			`Cannot safely locate reminder line in ${reminder.filePath}. The file may have been modified.`,
		);
	}
	return { content: replacement.content, lineNumber: replacement.lineNumber };
}
