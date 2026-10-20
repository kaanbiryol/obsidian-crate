import {
  DEFAULT_PROJECT,
} from "@/reminders/core/constants";
import { getUpcomingReminders, selectTodayReminders } from "@/reminders/core/reminderSort";
import { isReminderOverdue } from "@/reminders/core/dates/reminderDate";
import type { Reminder } from "@/reminders/types/reminder";
import type { TabId } from "@/reminders/ui/shared/layoutConstants";

export type ViewMode = TabId;

interface RemindersHeaderStats {
  count: number;
  overdueCount: number;
}

export interface RemindersHeaderData {
  inbox: RemindersHeaderStats;
  today: RemindersHeaderStats;
  upcoming: RemindersHeaderStats;
  browse: RemindersHeaderStats;
}

export interface CurrentHeaderData extends RemindersHeaderStats {
  title: "Inbox" | "Today" | "Upcoming" | "Projects";
}

export function getReminderProjects(reminders: Reminder[]): string[] {
  return Array.from(new Set(reminders.map((reminder) => reminder.project || DEFAULT_PROJECT))).sort();
}

export function getRemindersHeaderData(
  reminders: Reminder[],
  projects: string[],
  upcomingDays: number,
  now = new Date(),
): RemindersHeaderData {
  const activeReminders = reminders.filter((reminder) => !reminder.completed);
  const inboxReminders = activeReminders.filter(
    (reminder) => (reminder.project || DEFAULT_PROJECT) === DEFAULT_PROJECT,
  );
  const uniqueTodayReminders = selectTodayReminders(activeReminders, now, false);
  const upcomingReminders = getUpcomingReminders(activeReminders, upcomingDays, now);

  return {
    inbox: {
      count: inboxReminders.length,
      overdueCount: inboxReminders.filter((reminder) => isReminderOverdue(reminder, now)).length,
    },
    today: {
      count: uniqueTodayReminders.length,
      overdueCount: uniqueTodayReminders.filter((reminder) => isReminderOverdue(reminder, now)).length,
    },
    upcoming: {
      count: upcomingReminders.length,
      overdueCount: upcomingReminders.filter((reminder) => isReminderOverdue(reminder, now)).length,
    },
    browse: {
      count: projects.length,
      overdueCount: 0,
    },
  };
}

export function getCurrentHeaderData(
  viewMode: ViewMode,
  headerData: RemindersHeaderData,
): CurrentHeaderData {
  switch (viewMode) {
    case "inbox":
      return { title: "Inbox", ...headerData.inbox };
    case "today":
      return { title: "Today", ...headerData.today };
    case "upcoming":
      return { title: "Upcoming", ...headerData.upcoming };
    case "browse":
      return { title: "Projects", ...headerData.browse };
  }
}

export function getReminderCreateProject(
  viewMode: ViewMode,
  selectedProject: string | null,
): string {
  return viewMode === "inbox" || viewMode === "browse"
    ? selectedProject || DEFAULT_PROJECT
    : DEFAULT_PROJECT;
}

export function shouldShowReminderFab(
  viewMode: ViewMode,
  selectedProject: string | null,
): boolean {
  return viewMode !== "browse" || selectedProject !== null;
}

export function getReorderProject(
  viewMode: ViewMode,
  selectedProject: string | null,
): string | null {
  if (viewMode === "inbox") {
    return DEFAULT_PROJECT;
  }

  if (viewMode === "browse" && selectedProject) {
    return selectedProject;
  }

  return null;
}
