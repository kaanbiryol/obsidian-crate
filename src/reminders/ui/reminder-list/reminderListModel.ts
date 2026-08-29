import {
  getUpcomingReminders,
  groupRemindersByDate,
  sortReminders,
  sortRemindersByFileOrder,
} from "@/reminders/utils/reminderSort";
import { formatDateHeader, isReminderOverdue } from "@/reminders/utils/dateFormatting";
import type { ReminderRepository } from "@/reminders/data/reminder-repository";
import type { Reminder } from "@/reminders/types/plugin-reminder";

export interface RemindersListLoadOptions {
  repository: ReminderRepository;
  showToday?: boolean;
  showUpcoming?: boolean;
  showCompleted: boolean;
  effectiveDays: number;
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
    repository,
    showToday = false,
    showUpcoming = false,
    showCompleted,
    effectiveDays,
  } = options;

  if (showToday) {
    return repository.getTodayReminders(showCompleted);
  }

  if (showUpcoming) {
    const allReminders = showCompleted ? repository.getAll() : repository.getActive();
    return getUpcomingReminders(allReminders, effectiveDays);
  }

  return showCompleted ? repository.getAll() : repository.getActive();
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
