import { anchorMonthlyRecurrence, recurrenceCalendarDate, recurrenceCalendarInstant } from './recurrence/recurrenceCalendar';
import type { Priority, RecurrenceRule } from '@/reminders/types/reminder';
import { parseCheckboxLine, rebuildCheckboxLine } from '@/reminders/core/grammar/checkboxParser';
import { UnresolvedReminderScheduleError } from '@/reminders/core/grammar/reminderParser';
import { calculateFirstOccurrence, calculateNextOccurrence } from '@/reminders/core/recurrence/recurrenceCalculator';
import {
	buildStoredReminderDates,
	inferHasTimeFromDate,
	parseStoredReminderDate,
	reminderHasTime,
} from '@/reminders/core/dates/reminderDate';
import { normalizeRecurrenceRule } from '@/reminders/core/recurrence/recurrenceRule';
import { setReminderIdMarker } from './reminderIdentity';
import {
	appendReminderBlockToContent,
	assertReminderBlockUnchanged,
	findReminderLineNumber,
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
	return new ReminderInputError('content', 'This title cannot be saved as a reminder. Remove date, repeat or priority text from it.');
}

/** Every host reads the line back before writing it. A title ending in a number
 * range, such as "Read pages 13-19", can join the written date into a schedule
 * the saved-line parser rejects, which disables every reminder in the note. */
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
	const recurrence = rule && dueDate ? anchorMonthlyRecurrence(rule, dueDate, hasTime) : rule;
	const storedDates = buildStoredReminderDates(dueDate, hasTime);
	return assertReadsBack({
		checkboxLine: rebuildCheckboxLine(
			'',
			params.completed ?? false,
			params.content,
			dueDate,
			params.priority,
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
	});
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
	if (recurrence && dueDate) recurrence = anchorMonthlyRecurrence(recurrence, dueDate, hasTime);
	const priority = updates.priority ?? reminder.priority;
	const description = 'description' in updates
		? (updates.description?.trim() || undefined)
		: reminder.description;
	const indentation = reminder.rawLine.match(/^(\s*)/)?.[1] ?? '';
	const storedDates = buildStoredReminderDates(dueDate, hasTime);

	return assertReadsBack({
		checkboxLine: rebuildCheckboxLine(
			indentation,
			reminder.completed,
			content,
			dueDate,
			priority,
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
	});
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

export interface ReminderCompletionState {
	completed: boolean;
	dueDate?: string;
	dueDatetime?: string;
	recurrence: RecurrenceRule | undefined;
	recurringInstanceCompleted?: {
		completedDate: string;
		nextDate: string;
	};
}

export interface ReminderCompletionPlan extends ReminderCompletionState {
	checkboxLine: string;
}

export interface ReminderCompletionMutation extends ReminderCompletionPlan {
	content: string;
	lineNumber: number;
}

type CompletionStateInput = Pick<MarkdownReminderRecord, 'completed' | 'dueDate' | 'dueDatetime' | 'recurrence'>;
/** How the checkbox line changes: flip its marker, or rewrite it for a new occurrence. */
type CompletionLine = { kind: 'check' } | { kind: 'uncheck' } | { kind: 'rebuild'; completed: boolean; due: Date };

function completionTransition(
	reminder: CompletionStateInput,
	completed: boolean,
	currentDue: Date,
): { state: ReminderCompletionState; line: CompletionLine } {
	const currentHasTime = reminderHasTime(reminder) ?? false;
	let recurrence = normalizeRecurrenceRule(reminder.recurrence);
	let nextCompleted = completed;
	let dueDate = reminder.dueDate;
	let dueDatetime = reminder.dueDatetime;
	let line: CompletionLine;
	let recurringInstanceCompleted: ReminderCompletionState['recurringInstanceCompleted'];

	if (!completed) {
		const completedCount = recurrence?.completedCount ?? 0;
		if (reminder.completed && recurrence && completedCount > 0) {
			// Reopen the displayed occurrence without moving its date backwards.
			// Completing it again must restore the count, rather than double count it.
			recurrence = { ...recurrence, completedCount: completedCount - 1 };
			line = { kind: 'rebuild', completed: false, due: currentDue };
		} else line = { kind: 'uncheck' };
	} else if (recurrence && !reminder.completed) {
		recurrence = anchorMonthlyRecurrence(recurrence, currentDue, currentHasTime);
		const completedCount = recurrence.completedCount ?? 0;
		const nextInstant = calculateNextOccurrence(currentHasTime ? currentDue : recurrenceCalendarInstant(currentDue, recurrence), recurrence, completedCount);
		const nextDue = nextInstant && !currentHasTime ? recurrenceCalendarDate(nextInstant, recurrence) : nextInstant;
		recurrence = { ...recurrence, completedCount: completedCount + 1 };
		if (nextDue) {
			nextCompleted = false;
			const storedDates = buildStoredReminderDates(nextDue, currentHasTime);
			dueDate = storedDates.dueDate;
			dueDatetime = storedDates.dueDatetime;
			line = { kind: 'rebuild', completed: false, due: nextDue };
			recurringInstanceCompleted = {
				completedDate: currentDue.toISOString(),
				nextDate: nextDue.toISOString(),
			};
		} else {
			line = { kind: 'rebuild', completed: true, due: currentDue };
		}
	} else {
		line = { kind: 'check' };
	}

	return {
		state: { completed: nextCompleted, dueDate, dueDatetime, recurrence, recurringInstanceCompleted },
		line,
	};
}

/** The completion state transition alone: completion, dates and recurrence.
 * Hosts that predict a toggle without Markdown use this. */
export function planReminderCompletion(
	reminder: CompletionStateInput,
	completed: boolean,
	currentDue = parseStoredReminderDate(reminder) ?? new Date(),
): ReminderCompletionState {
	return completionTransition(reminder, completed, currentDue).state;
}

export function buildReminderCompletionPlan(
	reminder: MarkdownReminderRecord,
	completed: boolean,
	sourceLine = reminder.rawLine,
	currentDue = parseStoredReminderDate(reminder) ?? new Date(),
): ReminderCompletionPlan {
	const { state, line } = completionTransition(reminder, completed, currentDue);
	const nextLine = line.kind === 'check' ? sourceLine.replace(/\[ \]/, '[x]')
		: line.kind === 'uncheck' ? sourceLine.replace(/\[x\]/i, '[ ]')
		: rebuildCheckboxLine(sourceLine.match(/^(\s*)/)?.[1] ?? '', line.completed, reminder.content, line.due,
			reminder.priority, state.recurrence, reminderHasTime(reminder) ?? false, reminder.id);
	return { checkboxLine: setReminderIdMarker(nextLine, reminder.id), ...state };
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
