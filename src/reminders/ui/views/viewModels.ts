import { type Reminder } from "@/reminders/types/reminder";
import { getProjectColor, type ProjectColorScheme } from "@/reminders/ui/format/projectColors";
import { getUpcomingReminders, selectTodayReminders, sortReminders, sortRemindersByFileOrder } from "@/reminders/core/reminderSort";
import { DEFAULT_PROJECT } from "@/reminders/core/constants";
import { reminderProject } from "@/reminders/core/reminderProjectPath";

export interface ProjectStats {
  active: number;
  completed: number;
  total: number;
  completionPercentage: number;
}

export interface BrowseProjectCardViewModel {
  project: string;
  stats: ProjectStats;
  accentColor: string;
  isComplete: boolean;
}

export interface ProjectDetailHeaderViewModel {
  completedCount: number;
  total: number;
  completionPercentage: number;
  accentColor: string;
  isComplete: boolean;
}

const EMPTY_PROJECT_STATS: ProjectStats = {
  active: 0,
  completed: 0,
  total: 0,
  completionPercentage: 0,
};

export function buildInboxViewModel(reminders: Reminder[]): {
  active: Reminder[];
  completed: Reminder[];
} {
  const inboxReminders = reminders.filter(
    (reminder) => reminderProject(reminder) === DEFAULT_PROJECT,
  );
  const sorted = sortRemindersByFileOrder(inboxReminders);

  return {
    active: sorted.filter((reminder) => !reminder.completed),
    completed: sorted.filter((reminder) => reminder.completed),
  };
}

export function buildTodayViewModel(reminders: Reminder[], now = new Date()): {
  active: Reminder[];
  completed: Reminder[];
} {
  const sorted = sortReminders(selectTodayReminders(reminders, now, true));

  return {
    active: sorted.filter((reminder) => !reminder.completed),
    completed: sorted.filter((reminder) => reminder.completed),
  };
}

export function buildUpcomingViewModel(
  reminders: Reminder[],
  days: number,
  now = new Date(),
): {
  upcomingReminders: Reminder[];
} {
  const upcomingReminders = sortReminders(getUpcomingReminders(reminders, days, now));
  return { upcomingReminders };
}

export function buildProjectStatsMap(reminders: Reminder[]): Map<string, ProjectStats> {
  const counts = new Map<string, { active: number; completed: number; total: number }>();

  for (const reminder of reminders) {
    const project = reminderProject(reminder);
    const current = counts.get(project) ?? { active: 0, completed: 0, total: 0 };
    current.total += 1;
    if (reminder.completed) {
      current.completed += 1;
    } else {
      current.active += 1;
    }
    counts.set(project, current);
  }

  const finalized = new Map<string, ProjectStats>();
  for (const [project, stats] of counts.entries()) {
    finalized.set(project, {
      active: stats.active,
      completed: stats.completed,
      total: stats.total,
      completionPercentage: stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0,
    });
  }

  return finalized;
}

export function getProjectStats(
  projectStatsMap: Map<string, ProjectStats>,
  project: string,
): ProjectStats {
  return projectStatsMap.get(project) ?? EMPTY_PROJECT_STATS;
}

export function buildBrowseProjectCardsViewModel(
  projects: string[],
  reminders: Reminder[],
  colorScheme: ProjectColorScheme = "dark",
): BrowseProjectCardViewModel[] {
  const projectStatsMap = buildProjectStatsMap(reminders);

  return projects.map((project) => {
    const stats = getProjectStats(projectStatsMap, project);

    return {
      project,
      stats,
      accentColor: getProjectColor(project)[colorScheme].accent,
      isComplete: stats.total > 0 && stats.active === 0,
    };
  });
}

export function buildProjectDetailViewModel(
  reminders: Reminder[],
  project: string,
  colorScheme: ProjectColorScheme = "dark",
): {
  active: Reminder[];
  completed: Reminder[];
  accentColor: string;
  total: number;
  completionPercentage: number;
} {
  const projectReminders = reminders.filter((reminder) => reminderProject(reminder) === project);
  const sorted = sortRemindersByFileOrder(projectReminders);
  const active = sorted.filter((reminder) => !reminder.completed);
  const completed = sorted.filter((reminder) => reminder.completed);
  const total = projectReminders.length;

  return {
    active,
    completed,
    accentColor: getProjectColor(project)[colorScheme].accent,
    total,
    completionPercentage: total > 0 ? Math.round((completed.length / total) * 100) : 0,
  };
}

export function buildProjectDetailHeaderViewModel(
  detail: ReturnType<typeof buildProjectDetailViewModel>,
): ProjectDetailHeaderViewModel {
  return {
    completedCount: detail.completed.length,
    total: detail.total,
    completionPercentage: detail.completionPercentage,
    accentColor: detail.accentColor,
    isComplete: detail.total > 0 && detail.active.length === 0,
  };
}
