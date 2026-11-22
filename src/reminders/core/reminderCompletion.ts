import { anchorRecurrence, recurrenceCalendarDate, recurrenceCalendarInstant } from './recurrence/recurrenceCalendar';
import type { RecurrenceRule } from '@/reminders/core/model';
import { rebuildCheckboxLine } from '@/reminders/core/grammar/checkboxParser';
import { calculateNextOccurrence } from '@/reminders/core/recurrence/recurrenceCalculator';
import { buildStoredReminderDates, parseStoredReminderDate, reminderHasTime } from '@/reminders/core/dates/reminderDate';
import { normalizeRecurrenceRule } from '@/reminders/core/recurrence/recurrenceRule';
import { setReminderIdMarker } from './reminderIdentity';
import { assertReminderBlockUnchanged, findReminderLineNumber, matchLineEnding } from './markdownReminderFile';
import type { MarkdownReminderRecord } from './markdownReminderMutation';
import { setCompletionMarker } from './completionMetadata';

export interface ReminderCompletionState {
	completed: boolean;
	/** Set while the line stays checked; an occurrence that moves on to the next one has none. */
	completedAt?: string;
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

type CompletionStateInput = Pick<MarkdownReminderRecord, 'completed' | 'completedAt' | 'dueDate' | 'dueDatetime' | 'recurrence'>;
/** How the checkbox line changes: flip its marker, or rewrite it for a new occurrence. */
type CompletionLine = { kind: 'check' } | { kind: 'uncheck' } | { kind: 'rebuild'; completed: boolean; due: Date };

function completionTransition(
	reminder: CompletionStateInput,
	completed: boolean,
	currentDue: Date,
	completedAt: string,
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
		recurrence = anchorRecurrence(recurrence, currentDue, currentHasTime);
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

	// Completing an already completed line keeps the time it was first completed.
	const nextCompletedAt = !nextCompleted ? undefined : reminder.completed ? reminder.completedAt ?? completedAt : completedAt;
	return {
		state: { completed: nextCompleted, ...(nextCompletedAt ? { completedAt: nextCompletedAt } : {}), dueDate, dueDatetime, recurrence, recurringInstanceCompleted },
		line,
	};
}

/** The completion state transition alone: completion, completion time, dates and
 * recurrence. Hosts that predict a toggle without Markdown use this. */
export function planReminderCompletion(
	reminder: CompletionStateInput,
	completed: boolean,
	completedAt = new Date().toISOString(),
	currentDue = parseStoredReminderDate(reminder) ?? new Date(),
): ReminderCompletionState {
	return completionTransition(reminder, completed, currentDue, completedAt).state;
}

export function buildReminderCompletionPlan(
	reminder: MarkdownReminderRecord,
	completed: boolean,
	sourceLine = reminder.rawLine,
	currentDue = parseStoredReminderDate(reminder) ?? new Date(),
	completedAt = new Date().toISOString(),
): ReminderCompletionPlan {
	const { state, line } = completionTransition(reminder, completed, currentDue, completedAt);
	const nextLine = line.kind === 'check' ? setCompletionMarker(sourceLine.replace(/\[ \]/, '[x]'), state.completedAt)
		: line.kind === 'uncheck' ? setCompletionMarker(sourceLine.replace(/\[x\]/i, '[ ]'), undefined)
		: rebuildCheckboxLine({ indentation: sourceLine.match(/^(\s*)/)?.[1] ?? '', completed: line.completed, completedAt: state.completedAt, content: reminder.content,
			dueDate: line.due, priority: reminder.priority, recurrence: state.recurrence, hasTime: reminderHasTime(reminder) ?? false, reminderId: reminder.id });
	return { checkboxLine: setReminderIdMarker(nextLine, reminder.id), ...state };
}

export function setReminderCompletionInContent(
	fileContent: string,
	reminder: MarkdownReminderRecord,
	completed: boolean,
	currentDue?: Date,
	completedAt?: string,
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

	const plan = buildReminderCompletionPlan(reminder, completed, line, currentDue, completedAt);
	lines[lineNumber] = matchLineEnding([plan.checkboxLine], line)[0]!;
	return {
		...plan,
		content: lines.join('\n'),
		lineNumber,
	};
}
