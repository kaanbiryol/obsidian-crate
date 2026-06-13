import { type Reminder } from "@/reminders/types/reminder";
import { getProjectColor } from "@/reminders/utils/projectColors";
import {
  getCompletedTodayReminders,
  getOverdueReminders,
  getTodayReminders,
  getUpcomingReminders,
  groupRemindersByDate,
  sortReminders,
  sortRemindersByFileOrder,
} from "@/reminders/utils/reminderSort";
import { DEFAULT_PROJECT } from "@/reminders/utils/constants";

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
  activeCount: number;
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
    (reminder) => (reminder.project || DEFAULT_PROJECT) === DEFAULT_PROJECT,
  );
  const sorted = sortRemindersByFileOrder(inboxReminders);

  return {
    active: sorted.filter((reminder) => !reminder.completed),
    completed: sorted
      .filter((reminder) => reminder.completed)
      .sort((left, right) => {
        const leftTime = left.updatedAt ? new Date(left.updatedAt).getTime() : 0;
        const rightTime = right.updatedAt ? new Date(right.updatedAt).getTime() : 0;
        return leftTime - rightTime;
      }),
  };
}

export function buildTodayViewModel(reminders: Reminder[]): {
  active: Reminder[];
  completed: Reminder[];
} {
  const combined = [
    ...getOverdueReminders(reminders),
    ...getTodayReminders(reminders),
    ...getCompletedTodayReminders(reminders),
  ];
  const unique = Array.from(new Map(combined.map((reminder) => [reminder.id, reminder])).values());
  const sorted = sortReminders(unique);

  return {
    active: sorted.filter((reminder) => !reminder.completed),
    completed: sorted.filter((reminder) => reminder.completed),
  };
}

export function buildUpcomingViewModel(
  reminders: Reminder[],
  days: number,
): {
  upcomingReminders: Reminder[];
  dateGroups: Array<{ date: Date; reminders: Reminder[] }>;
} {
  const upcomingReminders = sortReminders(getUpcomingReminders(reminders, days));
  return {
    upcomingReminders,
    dateGroups: groupRemindersByDate(upcomingReminders),
  };
}

export function buildProjectStatsMap(reminders: Reminder[]): Map<string, ProjectStats> {
  const counts = new Map<string, { active: number; completed: number; total: number }>();

  for (const reminder of reminders) {
    const project = reminder.project || DEFAULT_PROJECT;
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
): BrowseProjectCardViewModel[] {
  const projectStatsMap = buildProjectStatsMap(reminders);

  return projects.map((project) => {
    const stats = getProjectStats(projectStatsMap, project);

    return {
      project,
      stats,
      accentColor: getProjectColor(project).dark.accent,
      isComplete: stats.total > 0 && stats.active === 0,
    };
  });
}

export function buildProjectDetailViewModel(
  reminders: Reminder[],
  project: string,
): {
  active: Reminder[];
  completed: Reminder[];
  accentColor: string;
  total: number;
  completionPercentage: number;
} {
  const projectReminders = reminders.filter((reminder) => (reminder.project || DEFAULT_PROJECT) === project);
  const sorted = sortRemindersByFileOrder(projectReminders);
  const active = sorted.filter((reminder) => !reminder.completed);
  const completed = sorted.filter((reminder) => reminder.completed);
  const total = projectReminders.length;

  return {
    active,
    completed,
    accentColor: getProjectColor(project).dark.accent,
    total,
    completionPercentage: total > 0 ? Math.round((completed.length / total) * 100) : 0,
  };
}

export function buildProjectDetailHeaderViewModel(
  reminders: Reminder[],
  project: string,
): ProjectDetailHeaderViewModel {
  const detail = buildProjectDetailViewModel(reminders, project);

  return {
    activeCount: detail.active.length,
    completedCount: detail.completed.length,
    total: detail.total,
    completionPercentage: detail.completionPercentage,
    accentColor: detail.accentColor,
    isComplete: detail.total > 0 && detail.active.length === 0,
  };
}
