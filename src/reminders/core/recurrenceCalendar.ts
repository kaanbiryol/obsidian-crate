import { fromDate, parseDateTime, toZoned } from '@internationalized/date';
import type { RecurrenceRule } from '../types/reminder';
import { getRecurrenceTimeZone } from '../utils/recurrenceRule';
import { formatLocalDateKey, parseLocalDateKey } from '../utils/reminderDate';

/** Date-only values are calendar days, never host-zone instants. */
export function recurrenceCalendarInstant(date: Date, rule: RecurrenceRule): Date {
	return toZoned(parseDateTime(`${formatLocalDateKey(date)}T00:00`), getRecurrenceTimeZone(rule)).toDate();
}
export function recurrenceCalendarDate(instant: Date, rule: RecurrenceRule): Date {
	const zoned = fromDate(instant, getRecurrenceTimeZone(rule));
	return parseLocalDateKey(`${String(zoned.year).padStart(4, '0')}-${String(zoned.month).padStart(2, '0')}-${String(zoned.day).padStart(2, '0')}`);
}
