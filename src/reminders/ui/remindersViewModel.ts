import {
  DEFAULT_PROJECT,
  getOverdueReminders,
  getTodayReminders,
  getUpcomingReminders,
  isReminderOverdue,
  type Reminder,
  type TabId,
} from "@/reminders";

export type ViewMode = TabId;

export interface RemindersHeaderStats {
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
): RemindersHeaderData {
  const activeReminders = reminders.filter((reminder) => !reminder.completed);
  const inboxReminders = activeReminders.filter(
    (reminder) => (reminder.project || DEFAULT_PROJECT) === DEFAULT_PROJECT,
  );
  const overdueReminders = getOverdueReminders(activeReminders);
  const todayReminders = getTodayReminders(activeReminders);
  const uniqueTodayReminders = [
    ...new Map([...overdueReminders, ...todayReminders].map((reminder) => [reminder.id, reminder])).values(),
  ];
  const upcomingReminders = getUpcomingReminders(activeReminders, upcomingDays);

  return {
    inbox: {
      count: inboxReminders.length,
      overdueCount: inboxReminders.filter((reminder) => isReminderOverdue(reminder)).length,
    },
    today: {
      count: uniqueTodayReminders.length,
      overdueCount: overdueReminders.length,
    },
    upcoming: {
      count: upcomingReminders.length,
      overdueCount: upcomingReminders.filter((reminder) => isReminderOverdue(reminder)).length,
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
