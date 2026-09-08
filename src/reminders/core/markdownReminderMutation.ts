import { recurrenceCalendarDate, recurrenceCalendarInstant } from './recurrenceCalendar';
import type { Priority, RecurrenceRule } from '@/reminders/types/reminder';
import { rebuildCheckboxLine } from '@/reminders/utils/checkboxParser';
import { calculateFirstOccurrence, calculateNextOccurrence } from '@/reminders/utils/recurrenceCalculator';
import {
	buildStoredReminderDates,
	inferHasTimeFromDate,
	parseStoredReminderDate,
	reminderHasTime,
} from '@/reminders/utils/reminderDate';
import { normalizeRecurrenceRule } from '@/reminders/utils/recurrenceRule';
import { setReminderIdMarker } from './reminderIdentity';
import {
	appendReminderBlockToContent,
	assertReminderBlockUnchanged,
	buildDescriptionBlock,
	findReminderLineNumber,
	replaceReminderBlockInContent,
	type ReminderLineRecord,
} from './markdownReminderFile';

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
	const recurrence = normalizeRecurrenceRule(params.recurrence);
	let dueDate = recurrence && !params.dueDate
		? calculateFirstOccurrence(recurrence)
		: params.dueDate;
	const hasTime = params.hasTime ?? (recurrence && !params.dueDate ? recurrence.hour !== undefined : inferHasTimeFromDate(dueDate));
	if (recurrence && !params.dueDate && dueDate && !hasTime) dueDate = recurrenceCalendarDate(dueDate, recurrence);
	const storedDates = buildStoredReminderDates(dueDate, hasTime);
	return {
		checkboxLine: rebuildCheckboxLine(
			'',
			params.completed ?? false,
			params.content,
			dueDate,
			params.priority,
			undefined,
			recurrence,
			hasTime,
			params.reminderId,
		),
		content: params.content,
		description: params.description?.trim() || undefined,
		dueDate,
		dueDateKey: storedDates.dueDate,
		dueDatetime: storedDates.dueDatetime,
		hasTime,
		priority: params.priority,
		recurrence,
	};
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
	const recurrence = Object.prototype.hasOwnProperty.call(updates, 'recurrence')
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
	const priority = updates.priority ?? reminder.priority;
	const description = 'description' in updates
		? (updates.description?.trim() || undefined)
		: reminder.description;
	const indentation = reminder.rawLine.match(/^(\s*)/)?.[1] ?? '';
	const storedDates = buildStoredReminderDates(dueDate, hasTime);

	return {
		checkboxLine: rebuildCheckboxLine(
			indentation,
			reminder.completed,
			content,
			dueDate,
			priority,
			undefined,
			recurrence,
			hasTime,
			reminder.id,
		),
		content,
		description,
		dueDate,
		dueDateKey: storedDates.dueDate,
		dueDatetime: storedDates.dueDatetime,
		hasTime,
		priority,
		recurrence,
	};
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

export interface ReminderCompletionPlan {
	checkboxLine: string;
	completed: boolean;
	dueDate?: string;
	dueDatetime?: string;
	recurrence: RecurrenceRule | undefined;
	recurringInstanceCompleted?: {
		completedDate: string;
		nextDate: string;
	};
}

export interface ReminderCompletionMutation extends ReminderCompletionPlan {
	content: string;
	lineNumber: number;
}

export function buildReminderCompletionPlan(
	reminder: MarkdownReminderRecord,
	completed: boolean,
	sourceLine = reminder.rawLine,
	currentDue = parseStoredReminderDate(reminder) ?? new Date(),
): ReminderCompletionPlan {
	const currentHasTime = reminderHasTime(reminder) ?? false;
	let recurrence = normalizeRecurrenceRule(reminder.recurrence);
	let nextCompleted = completed;
	let dueDate = reminder.dueDate;
	let dueDatetime = reminder.dueDatetime;
	let nextLine: string;
	let recurringInstanceCompleted: ReminderCompletionPlan['recurringInstanceCompleted'];

	if (!completed) {
		const completedCount = recurrence?.completedCount ?? 0;
		if (reminder.completed && recurrence && completedCount > 0) {
			// Reopen the displayed occurrence without moving its date backwards.
			// Completing it again must restore the count, rather than double count it.
			recurrence = { ...recurrence, completedCount: completedCount - 1 };
			nextLine = rebuildCheckboxLine(sourceLine.match(/^(\s*)/)?.[1] ?? '', false, reminder.content,
				currentDue, reminder.priority, undefined, recurrence, currentHasTime, reminder.id);
		} else nextLine = sourceLine.replace(/\[x\]/i, '[ ]');
	} else if (recurrence && !reminder.completed) {
		const completedCount = recurrence.completedCount ?? 0;
		const nextInstant = calculateNextOccurrence(currentHasTime ? currentDue : recurrenceCalendarInstant(currentDue, recurrence), recurrence, completedCount);
		const nextDue = nextInstant && !currentHasTime ? recurrenceCalendarDate(nextInstant, recurrence) : nextInstant;
		recurrence = { ...recurrence, completedCount: completedCount + 1 };
		if (nextDue) {
			nextCompleted = false;
			const storedDates = buildStoredReminderDates(nextDue, currentHasTime);
			dueDate = storedDates.dueDate;
			dueDatetime = storedDates.dueDatetime;
			nextLine = rebuildCheckboxLine(
				sourceLine.match(/^(\s*)/)?.[1] ?? '',
				false,
				reminder.content,
				nextDue,
				reminder.priority,
				undefined,
				recurrence,
				currentHasTime,
				reminder.id,
			);
			recurringInstanceCompleted = {
				completedDate: currentDue.toISOString(),
				nextDate: nextDue.toISOString(),
			};
		} else {
			nextLine = rebuildCheckboxLine(sourceLine.match(/^(\s*)/)?.[1] ?? '', true, reminder.content, currentDue, reminder.priority, undefined, recurrence, currentHasTime, reminder.id);
		}
	} else {
		nextLine = sourceLine.replace(/\[ \]/, '[x]');
	}

	return {
		checkboxLine: setReminderIdMarker(nextLine, reminder.id),
		completed: nextCompleted,
		dueDate,
		dueDatetime,
		recurrence,
		recurringInstanceCompleted,
	};
}

export function setReminderCompletionInContent(
	fileContent: string,
	reminder: MarkdownReminderRecord,
	completed: boolean,
	currentDue?: Date,
): ReminderCompletionMutation {
	const lines = fileContent.split('\n');
	const lineNumber = findReminderLineNumber(lines, reminder);
	if (lineNumber === -1) {
		throw new Error(`Cannot safely locate reminder line in ${reminder.filePath}`);
	}
	assertReminderBlockUnchanged(lines, reminder, lineNumber);
	const line = lines[lineNumber];
	if (line === undefined) {
		throw new Error(`Cannot read reminder line in ${reminder.filePath}`);
	}

	const plan = buildReminderCompletionPlan(reminder, completed, line, currentDue);
	lines[lineNumber] = plan.checkboxLine;
	return {
		...plan,
		content: lines.join('\n'),
		lineNumber,
	};
}
