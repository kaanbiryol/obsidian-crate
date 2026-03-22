import type { RecurrenceRule } from '../types/reminder';

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
  completedCount: number = 0
): Date | null {
  const interval = rule.interval || 1;
  let next = new Date(currentDue);

  switch (rule.frequency) {
    case 'daily':
      next.setDate(next.getDate() + interval);
      break;

    case 'weekly':
      if (rule.daysOfWeek && rule.daysOfWeek.length > 0) {
        // Find the next matching day of week
        next = findNextWeekday(currentDue, rule.daysOfWeek, interval);
      } else {
        // Simple weekly: add interval weeks
        next.setDate(next.getDate() + 7 * interval);
      }
      break;

    case 'monthly':
      if (rule.dayOfMonth) {
        // Avoid month overflow by moving to first of target month before setting day
        next.setDate(1);
        next.setMonth(next.getMonth() + interval);
        const targetDay = Math.min(rule.dayOfMonth, getDaysInMonth(next));
        next.setDate(targetDay);
      } else {
        next.setMonth(next.getMonth() + interval);
      }
      break;
  }

  // Check end conditions
  if (rule.endDate) {
    const endDate = new Date(rule.endDate);
    if (next > endDate) {
      return null;
    }
  }

  if (rule.count) {
    if (completedCount + 1 >= rule.count) {
      return null;
    }
  }

  return next;
}

/**
 * Find the next occurrence date that falls on one of the specified weekdays.
 * Handles multi-week intervals correctly.
 */
function findNextWeekday(
  fromDate: Date,
  daysOfWeek: number[],
  weekInterval: number
): Date {
  const sorted = [...daysOfWeek].sort((a, b) => a - b);
  const currentDay = fromDate.getDay();
  const result = new Date(fromDate);

  // First, check if there's another occurrence this week (same week)
  if (weekInterval === 1) {
    for (const targetDay of sorted) {
      if (targetDay > currentDay) {
        // Found a later day this week
        result.setDate(result.getDate() + (targetDay - currentDay));
        return result;
      }
    }
  }

  // Move to the next week(s) and find first matching day
  // Calculate days until the start of target week
  const daysUntilNextWeek = 7 - currentDay; // Days until Sunday
  const additionalWeeks = (weekInterval - 1) * 7;

  // Go to the first day of the target week (Sunday)
  result.setDate(result.getDate() + daysUntilNextWeek + additionalWeeks);

  // Find the first matching day in the target week
  const firstTargetDay = sorted[0];
  result.setDate(result.getDate() + firstTargetDay);

  return result;
}

/**
 * Get the number of days in a given month.
 */
function getDaysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

/**
 * Calculate the first occurrence date for a recurring reminder.
 * Used when creating a new recurring reminder without an explicit date.
 *
 * @param rule - The recurrence rule
 * @returns The first occurrence date (today or next matching day, with time from rule if specified)
 */
export function calculateFirstOccurrence(rule: RecurrenceRule): Date {
  const now = new Date();

  // Apply time from recurrence rule if specified, otherwise use current time
  if (rule.hour !== undefined && rule.minute !== undefined) {
    now.setHours(rule.hour, rule.minute, 0, 0);
  }

  // For weekly with specific days, find next matching day (including today)
  if (rule.frequency === 'weekly' && rule.daysOfWeek && rule.daysOfWeek.length > 0) {
    return findFirstMatchingDay(now, rule.daysOfWeek, rule.hour, rule.minute);
  }

  // For monthly with specific day
  if (rule.frequency === 'monthly' && rule.dayOfMonth) {
    return findFirstMonthlyDate(now, rule.dayOfMonth, rule.hour, rule.minute);
  }

  // For daily or simple recurrence, return today with specified time
  return now;
}

/**
 * Find the first matching day of week (including today if it matches).
 */
function findFirstMatchingDay(
  fromDate: Date,
  daysOfWeek: number[],
  hour?: number,
  minute?: number
): Date {
  const sorted = [...daysOfWeek].sort((a, b) => a - b);
  const currentDay = fromDate.getDay();
  const result = new Date(fromDate);

  // Check if today is a matching day
  if (sorted.includes(currentDay)) {
    // Today matches - use it
    if (hour !== undefined && minute !== undefined) {
      result.setHours(hour, minute, 0, 0);
    }
    return result;
  }

  // Find the next matching day
  for (const targetDay of sorted) {
    if (targetDay > currentDay) {
      // Found a later day this week
      result.setDate(result.getDate() + (targetDay - currentDay));
      if (hour !== undefined && minute !== undefined) {
        result.setHours(hour, minute, 0, 0);
      }
      return result;
    }
  }

  // No later day this week, go to first day next week
  const daysUntilNextWeek = 7 - currentDay;
  const firstTargetDay = sorted[0];
  result.setDate(result.getDate() + daysUntilNextWeek + firstTargetDay);
  if (hour !== undefined && minute !== undefined) {
    result.setHours(hour, minute, 0, 0);
  }
  return result;
}

/**
 * Find the first monthly occurrence (including this month if day hasn't passed).
 */
function findFirstMonthlyDate(
  fromDate: Date,
  dayOfMonth: number,
  hour?: number,
  minute?: number
): Date {
  const result = new Date(fromDate);
  const currentDayOfMonth = fromDate.getDate();
  const targetDay = Math.min(dayOfMonth, getDaysInMonth(fromDate));

  if (currentDayOfMonth <= targetDay) {
    // This month's target day hasn't passed yet
    result.setDate(targetDay);
  } else {
    // Move to next month
    result.setDate(1);
    result.setMonth(result.getMonth() + 1);
    const nextMonthTargetDay = Math.min(dayOfMonth, getDaysInMonth(result));
    result.setDate(nextMonthTargetDay);
  }

  if (hour !== undefined && minute !== undefined) {
    result.setHours(hour, minute, 0, 0);
  }
  return result;
}
