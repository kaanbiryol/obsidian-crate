import { afterEach, describe, expect, it, vi } from "vitest";
import type { Reminder } from "@/reminders/types/reminder";
import {
  buildInboxViewModel,
  buildProjectDetailViewModel,
  buildProjectStatsMap,
  buildTodayViewModel,
  buildUpcomingViewModel,
  getProjectStats,
} from "./viewModels";

function makeReminder(overrides: Partial<Reminder>): Reminder {
  return {
    id: overrides.id || "r1",
    content: overrides.content || "Task",
    priority: overrides.priority ?? 4,
    completed: overrides.completed ?? false,
    project: overrides.project,
    dueDate: overrides.dueDate,
    dueDatetime: overrides.dueDatetime,
    recurrence: overrides.recurrence,
    createdAt: overrides.createdAt || "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt || "2026-01-01T00:00:00.000Z",
    description: overrides.description,
    completedAt: overrides.completedAt,
    fileLink: overrides.fileLink,
    lineNumber: overrides.lineNumber,
  };
}

describe("reminder view models", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds inbox active/completed sections with stable file ordering", () => {
    const viewModel = buildInboxViewModel([
      makeReminder({ id: "b", project: "Inbox", lineNumber: 2 }),
      makeReminder({ id: "a", project: "Inbox", lineNumber: 1, completed: true, updatedAt: "2026-01-03T00:00:00.000Z" }),
      makeReminder({ id: "c", project: "Inbox", lineNumber: 3, completed: true, updatedAt: "2026-01-02T00:00:00.000Z" }),
      makeReminder({ id: "other", project: "Work" }),
    ]);

    expect(viewModel.active.map((reminder) => reminder.id)).toEqual(["b"]);
    expect(viewModel.completed.map((reminder) => reminder.id)).toEqual(["c", "a"]);
  });

  it("combines overdue and today reminders without duplicates", () => {
    const viewModel = buildTodayViewModel([
      makeReminder({ id: "today", dueDate: "2026-01-10" }),
      makeReminder({ id: "overdue", dueDate: "2026-01-08" }),
      makeReminder({ id: "done", dueDate: "2026-01-10", completed: true }),
    ]);

    expect(viewModel.map((reminder) => reminder.id)).toEqual(["overdue", "today"]);
  });

  it("builds upcoming groups and project stats/details", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-10T09:00:00.000Z"));

    const reminders = [
      makeReminder({ id: "work-active", project: "Work", dueDate: "2026-01-11" }),
      makeReminder({ id: "work-done", project: "Work", completed: true, dueDate: "2026-01-11" }),
      makeReminder({ id: "home", project: "Home", dueDate: "2026-01-12" }),
    ];

    const upcoming = buildUpcomingViewModel(reminders, 7);
    expect(upcoming.upcomingReminders.map((reminder) => reminder.id)).toEqual(["work-active", "home"]);
    expect(upcoming.dateGroups).toHaveLength(2);

    const projectStats = buildProjectStatsMap(reminders);
    expect(getProjectStats(projectStats, "Work")).toEqual({
      active: 1,
      completed: 1,
      total: 2,
      completionPercentage: 50,
    });

    const detail = buildProjectDetailViewModel(reminders, "Work");
    expect(detail.active.map((reminder) => reminder.id)).toEqual(["work-active"]);
    expect(detail.completed.map((reminder) => reminder.id)).toEqual(["work-done"]);
    expect(detail.total).toBe(2);
    expect(detail.completionPercentage).toBe(50);
    expect(detail.accentColor).toEqual(expect.any(String));
  });
});
