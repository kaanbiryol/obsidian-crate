/**
 * Reminder sorting utilities
 * Shared sorting logic for consistent ordering in the plugin
 */

import type { Reminder } from '../types/reminder';

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
      const timeA = new Date(dateA).getTime();
      const timeB = new Date(dateB).getTime();
      const dateDiff = timeA - timeB;
      if (dateDiff !== 0) return dateDiff;
    }

    // 3. Sort by priority (1 is highest, 4 is lowest)
    return a.priority - b.priority;
  });
}

/**
 * Get reminders due today
 */
export function getTodayReminders(reminders: Reminder[]): Reminder[] {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

  const todayStartISO = todayStart.toISOString();
  const todayEndISO = todayEnd.toISOString();

  return reminders.filter(r => {
    if (r.completed) return false;
    const dueDate = r.dueDatetime || r.dueDate;
    if (!dueDate) return false;
    return dueDate >= todayStartISO && dueDate < todayEndISO;
  });
}

/**
 * Get overdue reminders
 */
export function getOverdueReminders(reminders: Reminder[]): Reminder[] {
  const now = new Date().toISOString();

  return reminders.filter(r => {
    if (r.completed) return false;
    const dueDate = r.dueDatetime || r.dueDate;
    if (!dueDate) return false;
    return dueDate < now;
  });
}

/**
 * Get upcoming reminders (next N days)
 */
export function getUpcomingReminders(reminders: Reminder[], days: number = 7): Reminder[] {
  const now = new Date();
  const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1); // Tomorrow
  const endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days + 1);

  const startISO = startDate.toISOString();
  const endISO = endDate.toISOString();

  return reminders.filter(r => {
    if (r.completed) return false;
    const dueDate = r.dueDatetime || r.dueDate;
    if (!dueDate) return false;
    return dueDate >= startISO && dueDate < endISO;
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

    const dueDate = new Date(dueDateStr);
    const startOfDay = new Date(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
    const dateKey = startOfDay.toISOString().split('T')[0]; // YYYY-MM-DD

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
