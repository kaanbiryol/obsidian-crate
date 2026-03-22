import { format, isToday, isTomorrow, isPast } from 'date-fns';
import type { Reminder } from '../types/reminder';

/**
 * Format a due date for display
 * Shows "Today", "Tomorrow", or "MMM d" format with optional time
 * @param dateString - ISO date string
 * @returns Formatted date string or null
 */
export function formatDueDate(dateString: string | undefined): string | null {
  if (!dateString) return null;
  const date = new Date(dateString);

  let dateText = '';
  if (isToday(date)) {
    dateText = 'Today';
  } else if (isTomorrow(date)) {
    dateText = 'Tomorrow';
  } else {
    dateText = format(date, 'MMM d');
  }

  // Add time if available (presence of 'T' indicates time component)
  // Note: Don't check hours/minutes as date-only strings like 'YYYY-MM-DD'
  // are parsed as UTC by JavaScript, causing timezone issues
  if (dateString.includes('T')) {
    dateText += `, ${format(date, 'HH:mm')}`;
  }

  return dateText;
}

/**
 * Format a date header for grouping (used in UpcomingView)
 * @param date - Date to format
 * @returns Formatted date header
 */
export function formatDateHeader(date: Date): string {
  if (isToday(date)) return 'Today';
  if (isTomorrow(date)) return 'Tomorrow';
  return format(date, 'EEEE, MMM d');
}

/**
 * Check if a reminder is overdue
 * @param reminder - Reminder to check
 * @returns True if reminder is overdue
 */
export function isReminderOverdue(reminder: Reminder): boolean {
  const dueDate = reminder.dueDatetime || reminder.dueDate;
  return !!dueDate && isPast(new Date(dueDate)) && !reminder.completed;
}

/**
 * Check if a date string has a time component
 * @param dateString - ISO date string
 * @returns True if date has time component
 */
export function hasTimeComponent(dateString: string | undefined): boolean {
  if (!dateString) return false;
  // Only check for 'T' presence - don't check hours/minutes as
  // date-only strings like 'YYYY-MM-DD' are parsed as UTC by JavaScript,
  // causing timezone issues when checking local hours/minutes
  return dateString.includes('T');
}
