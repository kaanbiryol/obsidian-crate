import { parseCheckboxLine, type ParsedCheckbox } from './grammar/checkboxParser';
import { UnresolvedReminderScheduleError } from './grammar/reminderParser';
import { formatLocalDateKey } from './dates/reminderDate';
import { calculateFirstOccurrence } from './recurrence/recurrenceCalculator';
import { anchorRecurrence, recurrenceCalendarDate } from './recurrence/recurrenceCalendar';
import { appendRecurrenceMetadata } from './recurrence/recurrenceMetadata';
import { setReminderIdMarker } from './reminderIdentity';
import { recurrenceToText } from './recurrence/recurrenceText';

/** Resolve draft syntax once on the user's device before indexing/syncing it. */
export function normalizeReminderScheduleLine(
	line: string,
	parsePersisted: (line: string) => ParsedCheckbox | null = value => parseCheckboxLine(value, { persisted: true }),
): string {
	try {
		parsePersisted(line);
		return line;
	} catch (error) {
		if (!(error instanceof UnresolvedReminderScheduleError)) throw error;
	}
	const checkbox = parseCheckboxLine(line);
	if (!checkbox) return line;
	const { parsed } = checkbox;
	let recurrence = parsed.recurrence;
	let dueDate = parsed.dueDate;
	const hasTime = parsed.hasTime ?? (recurrence?.hour !== undefined);
	if (!dueDate && recurrence) {
		dueDate = calculateFirstOccurrence(recurrence);
		if (!hasTime) dueDate = recurrenceCalendarDate(dueDate, recurrence);
	}
	if (!dueDate) return line;
	if (recurrence) recurrence = anchorRecurrence(recurrence, dueDate, hasTime);
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
