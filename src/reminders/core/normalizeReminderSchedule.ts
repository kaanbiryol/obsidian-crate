import { parseCheckboxLine } from '../utils/checkboxParser';
import { UnresolvedReminderScheduleError } from '../utils/reminderParser';
import { formatLocalDateKey } from '../utils/reminderDate';
import { calculateFirstOccurrence } from '../utils/recurrenceCalculator';
import { recurrenceCalendarDate } from './recurrenceCalendar';
import { appendRecurrenceMetadata } from './recurrenceMetadata';
import { setReminderIdMarker } from './reminderIdentity';
import { recurrenceToText } from '../utils/rruleConverter';

/** Resolve draft syntax once on the user's device before indexing/syncing it. */
export function normalizeReminderScheduleLine(line: string): string {
	try {
		parseCheckboxLine(line, { persisted: true });
		return line;
	} catch (error) {
		if (!(error instanceof UnresolvedReminderScheduleError)) throw error;
	}
	const checkbox = parseCheckboxLine(line);
	if (!checkbox) return line;
	const { parsed } = checkbox;
	const recurrence = parsed.recurrence;
	let dueDate = parsed.dueDate;
	const hasTime = parsed.hasTime ?? (recurrence?.hour !== undefined);
	if (!dueDate && recurrence) {
		dueDate = calculateFirstOccurrence(recurrence);
		if (!hasTime) dueDate = recurrenceCalendarDate(dueDate, recurrence);
	}
	if (!dueDate) return line;
	const dateText = hasTime ? dueDate.toISOString() : formatLocalDateKey(dueDate);
	let content = checkbox.rawContent;
	if (parsed.datePart && parsed.datePart !== parsed.recurrencePart) {
		const position = content.lastIndexOf(parsed.datePart);
		if (position === -1) throw new UnresolvedReminderScheduleError();
		content = content.slice(0, position) + dateText + content.slice(position + parsed.datePart.length);
	} else {
		content = `${content} ${dateText}`;
	}
	if (recurrence && parsed.recurrencePart) content = content.replace(parsed.recurrencePart, recurrenceToText(recurrence));
	const normalized = appendRecurrenceMetadata(`${checkbox.indentation}- [${checkbox.isCompleted ? 'x' : ' '}] ${content}`, recurrence);
	return checkbox.reminderId ? setReminderIdMarker(normalized, checkbox.reminderId) : normalized;
}
