import {
  getUpcomingReminders,
  groupRemindersByDate,
  sortReminders,
  sortRemindersByFileOrder,
} from "@/reminders/utils/reminderSort";
import { formatDateHeader, isReminderOverdue } from "@/reminders/utils/dateFormatting";
import { indexedToReminder, type IndexedReminder, type ReminderIndex } from "@/reminders/data/reminderIndex";
import type { StorageCompat } from "@/reminders/data/storageCompat";
import type { Reminder } from "@/reminders/types/plugin-reminder";
import { formatLocalDateKey } from "@/reminders/utils/reminderDate";

export interface RemindersListLoadOptions {
  reminderIndex?: ReminderIndex;
  storage: StorageCompat;
  showToday?: boolean;
  showUpcoming?: boolean;
  showCompleted: boolean;
  effectiveDays: number;
  todayPrefix: string;
}

export interface RemindersListPresentationOptions {
  rawReminders: Reminder[];
  projectFilter?: string;
  showToday?: boolean;
  showUpcoming?: boolean;
  effectiveDays: number;
}

export interface RemindersListPresentation {
  reminders: Reminder[];
  activeReminders: Reminder[];
  activeCount: number;
  completedCount: number;
  overdueCount: number;
  supportsReorder: boolean;
  effectiveProject: string;
  emptyMessage: string;
  dateGroups: Array<{ date: Date; reminders: Reminder[] }> | null;
}

export async function loadRemindersListData(options: RemindersListLoadOptions): Promise<Reminder[]> {
  const {
    reminderIndex,
    storage,
    showToday = false,
    showUpcoming = false,
    showCompleted,
    effectiveDays,
    todayPrefix,
  } = options;

  if (reminderIndex?.isLoaded) {
    if (showToday) {
      return getTodayIndexReminders(reminderIndex, showCompleted, todayPrefix).map(indexedToReminder);
    }

    if (showUpcoming) {
      const source = showCompleted ? reminderIndex.getAll() : reminderIndex.getActive();
      return getUpcomingReminders(source.map(indexedToReminder), effectiveDays);
    }

    return (showCompleted ? reminderIndex.getAll() : reminderIndex.getActive()).map(indexedToReminder);
  }

  if (showToday) {
    return storage.getTodayReminders(showCompleted);
  }

  if (showUpcoming) {
    const allReminders = showCompleted ? storage.getAll() : storage.getActive();
    return getUpcomingReminders(allReminders, effectiveDays);
  }

  return showCompleted ? storage.getAll() : storage.getActive();
}

export function buildRemindersListPresentation(
  options: RemindersListPresentationOptions,
): RemindersListPresentation {
  const {
    rawReminders,
    projectFilter,
    showToday = false,
    showUpcoming = false,
    effectiveDays,
  } = options;

  const supportsReorder = Boolean(projectFilter && !showToday && !showUpcoming);
  const effectiveProject = projectFilter?.trim() || "Inbox";
  const normalizedProject = projectFilter?.toLowerCase().trim();
  const filteredReminders = normalizedProject
    ? rawReminders.filter((reminder) => (reminder.project || "Inbox").toLowerCase() === normalizedProject)
    : [...rawReminders];
  const reminders = supportsReorder
    ? sortRemindersByFileOrder(filteredReminders)
    : sortReminders(filteredReminders);
  const activeReminders = reminders.filter((reminder) => !reminder.completed);
  const completedCount = reminders.length - activeReminders.length;
  const overdueCount = reminders.filter((reminder) => isReminderOverdue(reminder)).length;

  return {
    reminders,
    activeReminders,
    activeCount: activeReminders.length,
    completedCount,
    overdueCount,
    supportsReorder,
    effectiveProject,
    emptyMessage: buildEmptyMessage({ showToday, showUpcoming, effectiveDays, projectFilter }),
    dateGroups: showUpcoming ? groupRemindersByDate(reminders) : null,
  };
}

function getTodayIndexReminders(
  reminderIndex: ReminderIndex,
  showCompleted: boolean,
  todayPrefix: string,
): IndexedReminder[] {
  const todayReminders = reminderIndex.getToday();
  const overdueReminders = reminderIndex.getOverdue();
  const todayAndOverdueMap = new Map<string, IndexedReminder>();

  for (const reminder of [...todayReminders, ...overdueReminders]) {
    todayAndOverdueMap.set(reminder.id, reminder);
  }

  let indexed = Array.from(todayAndOverdueMap.values());
  if (showCompleted) {
    const completedToday = reminderIndex.getCompleted().filter((reminder) => {
      if (reminder.dueDatetime) {
        return formatLocalDateKey(new Date(reminder.dueDatetime)) === todayPrefix;
      }
      return reminder.dueDate === todayPrefix;
    });
    indexed = [...indexed, ...completedToday];
  }

  return indexed;
}

function buildEmptyMessage(options: {
  showToday: boolean;
  showUpcoming: boolean;
  effectiveDays: number;
  projectFilter?: string;
}): string {
  if (options.showToday) {
    return "No reminders due today";
  }
  if (options.showUpcoming) {
    return `No reminders in the next ${options.effectiveDays} days`;
  }
  if (options.projectFilter) {
    return `No reminders in project "${options.projectFilter}"`;
  }
  return "No reminders";
}

export { formatDateHeader };
