/**
 * Reminder sorting utilities
 * Shared sorting logic for consistent ordering in the plugin
 */

import type { Reminder } from '../types/reminder';
import { formatLocalDateKey, isDateOnlyString, parseReminderDateValue } from './reminderDate';

/**
 * Sort reminders by:
 * 1. Completion status (incomplete first)
 * 2. Due date/time (earliest first, null dates last)
 * 3. Priority (highest priority first: 1 > 2 > 3 > 4)
 *
 * This ensures consistent sorting in the plugin.
 */
export function sortReminders(reminders: Reminder[]): Reminder[] {
  return [...reminders].sort((a, b) => {
    // 1. Sort by completion status (incomplete first)
    if (a.completed !== b.completed) {
      return a.completed ? 1 : -1;
    }

    // 2. Sort by due date (earliest first, no date goes last)
    const dateA = a.dueDatetime || a.dueDate;
    const dateB = b.dueDatetime || b.dueDate;

    // If only one has a date, prioritize the one with a date
    if (dateA && !dateB) return -1;
    if (!dateA && dateB) return 1;

    // If both have dates, compare them
    if (dateA && dateB) {
      const timeA = parseReminderDateValue(dateA, !isDateOnlyString(dateA))?.getTime() ?? 0;
      const timeB = parseReminderDateValue(dateB, !isDateOnlyString(dateB))?.getTime() ?? 0;
      const dateDiff = timeA - timeB;
      if (dateDiff !== 0) return dateDiff;
    }

    // 3. Sort by priority (1 is highest, 4 is lowest)
    return a.priority - b.priority;
  });
}

/**
 * Sort reminders by file line order (for manual sort mode).
 * Incomplete reminders first, then by line number ascending.
 */
export function sortRemindersByFileOrder(reminders: Reminder[]): Reminder[] {
  return [...reminders].sort((a, b) => {
    if (a.completed !== b.completed) {
      return a.completed ? 1 : -1;
    }
    return (a.lineNumber ?? Infinity) - (b.lineNumber ?? Infinity);
  });
}

/**
 * Get reminders due today
 */
export function getTodayReminders(reminders: Reminder[]): Reminder[] {
  const todayKey = formatLocalDateKey(new Date());

  return reminders.filter(r => {
    if (r.completed) return false;
    if (r.dueDatetime) {
      return formatLocalDateKey(new Date(r.dueDatetime)) === todayKey;
    }
    return r.dueDate === todayKey;
  });
}

/**
 * Get overdue reminders
 */
export function getOverdueReminders(reminders: Reminder[]): Reminder[] {
  const now = new Date();
  const todayKey = formatLocalDateKey(now);

  return reminders.filter(r => {
    if (r.completed) return false;
    if (r.dueDatetime) {
      return new Date(r.dueDatetime) < now;
    }
    return !!r.dueDate && r.dueDate < todayKey;
  });
}

/**
 * Get upcoming reminders (next N days)
 */
export function getUpcomingReminders(reminders: Reminder[], days: number = 7): Reminder[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startDate = new Date(todayStart);
  startDate.setDate(startDate.getDate() + 1);
  const endDate = new Date(todayStart);
  endDate.setDate(endDate.getDate() + days + 1);

  return reminders.filter(r => {
    if (r.completed) return false;
    if (r.dueDatetime) {
      const dueDate = new Date(r.dueDatetime);
      return dueDate > now && dueDate < endDate;
    }
    const dueDate = parseReminderDateValue(r.dueDate, false);
    return !!dueDate && dueDate >= startDate && dueDate < endDate;
  });
}

/**
 * Get the due date from a reminder
 */
function getReminderDueDate(reminder: Reminder): string | undefined {
  return reminder.dueDatetime || reminder.dueDate;
}

/**
 * Group reminders by date
 * Returns array of { date, reminders } objects sorted by date
 */
export function groupRemindersByDate(reminders: Reminder[]): Array<{ date: Date; reminders: Reminder[] }> {
  const grouped: Record<string, { date: Date; reminders: Reminder[] }> = {};

  for (const reminder of reminders) {
    const dueDateStr = getReminderDueDate(reminder);
    if (!dueDateStr) continue;

    const dueDate = parseReminderDateValue(dueDateStr, !isDateOnlyString(dueDateStr));
    if (!dueDate) continue;
    const startOfDay = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
    const dateKey = formatLocalDateKey(startOfDay);

    if (!grouped[dateKey]) {
      grouped[dateKey] = {
        date: startOfDay,
        reminders: [],
      };
    }
    grouped[dateKey].reminders.push(reminder);
  }

  return Object.values(grouped).sort((a, b) => a.date.getTime() - b.date.getTime());
}
