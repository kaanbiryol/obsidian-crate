import { fromDate, parseDateTime, toZoned } from '@internationalized/date';
import type { RecurrenceRule } from '../../types/reminder';
import { getRecurrenceTimeZone } from './recurrenceRule';
import { formatLocalDateKey, parseLocalDateKey, formatDateKeyParts } from '../dates/reminderDate';

/** Date-only values are calendar days, never host-zone instants. */
export function recurrenceCalendarInstant(date: Date, rule: RecurrenceRule): Date {
	return toZoned(parseDateTime(`${formatLocalDateKey(date)}T00:00`), getRecurrenceTimeZone(rule)).toDate();
}
export function recurrenceCalendarDate(instant: Date, rule: RecurrenceRule): Date {
	const zoned = fromDate(instant, getRecurrenceTimeZone(rule));
	return parseLocalDateKey(formatDateKeyParts(zoned.year, zoned.month, zoned.day));
}

/** "Every month" follows the day of its due date. Writing that day into the
 * rule keeps later occurrences on it after a shorter month clamps one. */
export function anchorMonthlyRecurrence(rule: RecurrenceRule, due: Date, hasTime: boolean | undefined): RecurrenceRule {
	if (rule.frequency !== 'monthly' || rule.dayOfMonth) return rule;
	const instant = hasTime ? due : recurrenceCalendarInstant(due, rule);
	return { ...rule, dayOfMonth: fromDate(instant, getRecurrenceTimeZone(rule)).day };
}
