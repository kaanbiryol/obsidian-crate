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

/** "Every month" follows the day of its due date, and a timed repeat its time.
 * Writing them into the rule keeps later occurrences on them after a shorter
 * month clamps the day or a daylight-saving gap moves the time. A date-only
 * due has no time, and its Markdown line cannot carry a repeat time. */
export function anchorRecurrence(rule: RecurrenceRule, due: Date, hasTime: boolean | undefined): RecurrenceRule {
	const { hour, minute, second, millisecond, ...untimed } = rule;
	const anchored = hasTime || [hour, minute, second, millisecond].every(value => value === undefined) ? rule : untimed;
	const day = rule.frequency === 'monthly' && !rule.dayOfMonth;
	const time = Boolean(hasTime) && (hour === undefined || minute === undefined);
	if (!day && !time) return anchored;
	const zoned = fromDate(hasTime ? due : recurrenceCalendarInstant(due, rule), getRecurrenceTimeZone(rule));
	return { ...anchored, ...(day ? { dayOfMonth: zoned.day } : {}), ...(time ? { hour: zoned.hour, minute: zoned.minute } : {}) };
}
