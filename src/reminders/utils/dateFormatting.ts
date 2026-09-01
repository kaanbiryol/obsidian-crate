import { isToday, isTomorrow, isPast } from 'date-fns';
import type { Reminder } from '../types/reminder';
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
): string | null {
  if (!dateString) return null;
  const hasTime = dateString.includes('T');
  const date = parseReminderDateValue(dateString, hasTime);
  if (!date) return null;

  let dateText = '';
  if (isToday(date)) {
    dateText = formatRelativeDay(0, locale);
  } else if (isTomorrow(date)) {
    dateText = formatRelativeDay(1, locale);
  } else {
    dateText = new Intl.DateTimeFormat(locale, {
      month: 'short',
      day: 'numeric',
    }).format(date);
  }

  // Add time if available (presence of 'T' indicates time component)
  // Note: Don't check hours/minutes as date-only strings like 'YYYY-MM-DD'
  // are parsed as UTC by JavaScript, causing timezone issues
  if (dateString.includes('T')) {
    const timeText = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
    dateText += `, ${timeText}`;
  }

  return dateText;
}

/**
 * Format a date header for grouping (used in UpcomingView)
 * @param date - Date to format
 * @returns Formatted date header
 */
export function formatDateHeader(date: Date, locale = getUiLocale()): string {
  if (isToday(date)) return formatRelativeDay(0, locale);
  if (isTomorrow(date)) return formatRelativeDay(1, locale);
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
export function isReminderOverdue(reminder: Pick<Reminder, 'dueDate' | 'dueDatetime' | 'completed'>): boolean {
  if (reminder.completed) return false;
  if (reminder.dueDatetime) {
    return isPast(new Date(reminder.dueDatetime));
  }
  if (reminder.dueDate) {
    return reminder.dueDate < formatLocalDateKey(new Date());
  }
  return false;
}
