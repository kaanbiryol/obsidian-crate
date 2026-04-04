import {
  fromDate,
  getDayOfWeek,
  now as zonedNow,
  type ZonedDateTime,
} from '@internationalized/date';
import type { RecurrenceRule } from '../types/reminder';
import { getRecurrenceTimeZone } from './recurrenceRule';
import { isDateOnlyString } from './reminderDate';

/**
 * Calculate the next occurrence date for a recurring reminder.
 * Returns null if there are no more occurrences (end date reached or count exhausted).
 *
 * @param currentDue - The current due date/datetime
 * @param rule - The recurrence rule
 * @param completedCount - Number of times already completed (for COUNT-based rules)
 * @returns The next occurrence date, or null if no more occurrences
 */
export function calculateNextOccurrence(
  currentDue: Date,
  rule: RecurrenceRule,
  completedCount: number = 0,
): Date | null {
  const interval = rule.interval || 1;
  const timeZone = getRecurrenceTimeZone(rule);
  const currentZoned = fromDate(currentDue, timeZone);
  const current = applyRuleTime(currentZoned, rule, currentZoned);
  let next = current;

  switch (rule.frequency) {
    case 'daily':
      next = applyRuleTime(current.add({ days: interval }), rule, current);
      break;

    case 'weekly':
      if (rule.daysOfWeek && rule.daysOfWeek.length > 0) {
        next = findNextWeekday(current, rule.daysOfWeek, interval, rule);
      } else {
        next = applyRuleTime(current.add({ days: 7 * interval }), rule, current);
      }
      break;

    case 'monthly':
      if (rule.dayOfMonth) {
        next = findNextMonthlyDate(current, rule.dayOfMonth, interval, rule);
      } else {
        next = applyRuleTime(current.add({ months: interval }), rule, current);
      }
      break;
  }

  if (rule.endDate && isBeyondRecurrenceEnd(next, rule.endDate)) {
    return null;
  }

  if (rule.count && completedCount + 1 >= rule.count) {
    return null;
  }

  return next.toDate();
}

/**
 * Calculate the first occurrence date for a recurring reminder.
 * Used when creating a new recurring reminder without an explicit date.
 *
 * @param rule - The recurrence rule
 * @returns The first occurrence date (today or next matching day, with time from rule if specified)
 */
export function calculateFirstOccurrence(rule: RecurrenceRule): Date {
  const current = zonedNow(getRecurrenceTimeZone(rule));
  let first = applyRuleTime(current, rule);

  if (rule.frequency === 'weekly' && rule.daysOfWeek && rule.daysOfWeek.length > 0) {
    first = findFirstMatchingDay(first, rule.daysOfWeek, rule);
  } else if (rule.frequency === 'monthly' && rule.dayOfMonth) {
    first = findFirstMonthlyDate(first, rule.dayOfMonth, rule);
  }

  if (hasExplicitTime(rule) && first.compare(current) <= 0) {
    return calculateNextOccurrence(first.toDate(), rule) ?? first.toDate();
  }

  return first.toDate();
}

/**
 * Find the next occurrence date that falls on one of the specified weekdays.
 * Handles multi-week intervals correctly.
 */
function findNextWeekday(
  fromDate: ZonedDateTime,
  daysOfWeek: number[],
  weekInterval: number,
  rule: RecurrenceRule,
): ZonedDateTime {
  const sorted = [...daysOfWeek].sort((a, b) => a - b);
  const currentDay = getDayOfWeek(fromDate, 'en-US');
  let result = fromDate;

  for (const targetDay of sorted) {
    if (targetDay > currentDay) {
      return applyRuleTime(result.add({ days: targetDay - currentDay }), rule, fromDate);
    }
  }

  const daysUntilNextWeek = 7 - currentDay;
  const additionalWeeks = (weekInterval - 1) * 7;
  const firstTargetDay = sorted[0];
  result = result.add({ days: daysUntilNextWeek + additionalWeeks + firstTargetDay });
  return applyRuleTime(result, rule, fromDate);
}

function findFirstMatchingDay(
  fromDate: ZonedDateTime,
  daysOfWeek: number[],
  rule: RecurrenceRule,
): ZonedDateTime {
  const sorted = [...daysOfWeek].sort((a, b) => a - b);
  const currentDay = getDayOfWeek(fromDate, 'en-US');
  let result = fromDate;

  if (sorted.includes(currentDay)) {
    return applyRuleTime(result, rule, fromDate);
  }

  for (const targetDay of sorted) {
    if (targetDay > currentDay) {
      result = result.add({ days: targetDay - currentDay });
      return applyRuleTime(result, rule, fromDate);
    }
  }

  const daysUntilNextWeek = 7 - currentDay;
  const firstTargetDay = sorted[0];
  result = result.add({ days: daysUntilNextWeek + firstTargetDay });
  return applyRuleTime(result, rule, fromDate);
}

function findNextMonthlyDate(
  fromDate: ZonedDateTime,
  dayOfMonth: number,
  interval: number,
  rule: RecurrenceRule,
): ZonedDateTime {
  let result = fromDate.set({ day: 1 }).add({ months: interval });
  const targetDay = Math.min(dayOfMonth, getDaysInMonth(result.year, result.month));
  result = result.set({ day: targetDay });
  return applyRuleTime(result, rule, fromDate);
}

function findFirstMonthlyDate(
  fromDate: ZonedDateTime,
  dayOfMonth: number,
  rule: RecurrenceRule,
): ZonedDateTime {
  let result = fromDate;
  const targetDay = Math.min(dayOfMonth, getDaysInMonth(fromDate.year, fromDate.month));

  if (fromDate.day <= targetDay) {
    result = result.set({ day: targetDay });
  } else {
    result = result.set({ day: 1 }).add({ months: 1 });
    result = result.set({ day: Math.min(dayOfMonth, getDaysInMonth(result.year, result.month)) });
  }

  return applyRuleTime(result, rule, fromDate);
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function applyRuleTime(
  value: ZonedDateTime,
  rule: RecurrenceRule,
  fallback?: ZonedDateTime,
): ZonedDateTime {
  const source = hasExplicitTime(rule) ? rule : fallback;
  return value.set({
    hour: source?.hour ?? 0,
    minute: source?.minute ?? 0,
    second: 0,
    millisecond: 0,
  });
}

function hasExplicitTime(rule: RecurrenceRule): rule is RecurrenceRule & { hour: number; minute: number } {
  return rule.hour !== undefined && rule.minute !== undefined;
}

function isBeyondRecurrenceEnd(nextDate: ZonedDateTime, endDate: string): boolean {
  if (isDateOnlyString(endDate)) {
    return zonedDateKey(nextDate) > endDate;
  }

  return nextDate.toDate() > new Date(endDate);
}

function zonedDateKey(value: ZonedDateTime): string {
  const month = `${value.month}`.padStart(2, '0');
  const day = `${value.day}`.padStart(2, '0');
  return `${value.year}-${month}-${day}`;
}
