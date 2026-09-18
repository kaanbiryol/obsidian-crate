import type { Reminder, RecurrenceRule } from '../types/reminder';
import { formatLocalDateKey, parseReminderDateValue } from './reminderDate';
import { getUiLocale, sentenceCaseLocalized } from './uiLocale';

function formatRelativeDay(offset: number, locale = getUiLocale()): string {
  const value = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(offset, 'day');
  return sentenceCaseLocalized(value, locale);
}

/**
 * Format a due date for display
 * Shows "Today", "Tomorrow", or "MMM d" format with optional time
 * @param dateString - ISO date string
 * @returns Formatted date string or null
 */
export function formatDueDate(
  dateString: string | undefined,
  locale = getUiLocale(),
  now = new Date(),
  recurrence?: RecurrenceRule,
): string | null {
  if (!dateString) return null;
  const hasTime = dateString.includes('T');
  const date = parseReminderDateValue(dateString, hasTime);
  if (!date) return null;

  let dateText = '';
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (formatLocalDateKey(date) === formatLocalDateKey(now)) {
    dateText = formatRelativeDay(0, locale);
  } else if (formatLocalDateKey(date) === formatLocalDateKey(tomorrow)) {
    dateText = formatRelativeDay(1, locale);
  } else {
    dateText = new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
    }).format(date);
  }

  // Explicit timestamps take precedence over the recurring schedule's time.
  const recurrenceHour = recurrence?.hour;
  if (hasTime || recurrenceHour !== undefined) {
    // Date-only occurrences keep their wall-clock time in the repeat rule.
    // Format that time in UTC to avoid shifting it through a local DST gap.
    const time = hasTime ? date : new Date(Date.UTC(2000, 0, 1, recurrenceHour, recurrence?.minute ?? 0));
    const timeText = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit', hourCycle: 'h23',
      ...(!hasTime ? { timeZone: 'UTC' } : {}),
    }).format(time);
    dateText += `, ${timeText}`;
  }

  return dateText;
}

/**
 * Format a date header for grouping (used in UpcomingView)
 * @param date - Date to format
 * @returns Formatted date header
 */
export function formatDateHeader(date: Date, locale = getUiLocale(), now = new Date()): string {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (formatLocalDateKey(date) === formatLocalDateKey(now)) return formatRelativeDay(0, locale);
  if (formatLocalDateKey(date) === formatLocalDateKey(tomorrow)) return formatRelativeDay(1, locale);
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

/**
 * Check if a reminder is overdue
 * @param reminder - Reminder to check
 * @returns True if reminder is overdue
 */
export function isReminderOverdue(reminder: Pick<Reminder, 'dueDate' | 'dueDatetime' | 'completed'>, now = new Date()): boolean {
  if (reminder.completed) return false;
  if (reminder.dueDatetime) {
    return new Date(reminder.dueDatetime) < now;
  }
  if (reminder.dueDate) {
    return reminder.dueDate < formatLocalDateKey(now);
  }
  return false;
}
