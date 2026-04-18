import { describe, expect, it, vi } from "vitest";
import type { Reminder } from "@/reminders";
import {
  getCurrentHeaderData,
  getReminderCreateProject,
  getReminderProjects,
  getRemindersHeaderData,
  getReorderProject,
  shouldShowReminderFab,
} from "./remindersViewModel";

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

describe("remindersViewModel", () => {
  it("builds sorted project lists with Inbox fallback", () => {
    const reminders = [
      makeReminder({ id: "r1", project: "Work" }),
      makeReminder({ id: "r2", project: undefined }),
      makeReminder({ id: "r3", project: "Home" }),
      makeReminder({ id: "r4", project: "Work" }),
    ];

    expect(getReminderProjects(reminders)).toEqual(["Home", "Inbox", "Work"]);
  });

  it("characterizes header counts for inbox, today, upcoming, and browse", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-10T09:00:00.000Z"));

    const reminders = [
      makeReminder({ id: "inbox-overdue", dueDate: "2026-01-05" }),
      makeReminder({ id: "inbox-today", dueDate: "2026-01-10" }),
      makeReminder({ id: "work-upcoming", project: "Work", dueDatetime: "2026-01-12T08:00:00.000Z" }),
      makeReminder({ id: "done", completed: true, dueDate: "2026-01-10" }),
    ];

    const headerData = getRemindersHeaderData(reminders, ["Inbox", "Work"], 7);

    expect(headerData).toEqual({
      inbox: { count: 2, overdueCount: 1 },
      today: { count: 2, overdueCount: 1 },
      upcoming: { count: 1, overdueCount: 0 },
      browse: { count: 2, overdueCount: 0 },
    });
    expect(getCurrentHeaderData("today", headerData)).toEqual({
      title: "Today",
      count: 2,
      overdueCount: 1,
    });

    vi.useRealTimers();
  });

  it("derives creation project, fab visibility, and reorder target from the current view", () => {
    expect(getReminderCreateProject("inbox", null)).toBe("Inbox");
    expect(getReminderCreateProject("browse", "Work")).toBe("Work");
    expect(getReminderCreateProject("today", "Work")).toBe("Inbox");

    expect(shouldShowReminderFab("browse", null)).toBe(false);
    expect(shouldShowReminderFab("browse", "Work")).toBe(true);
    expect(shouldShowReminderFab("today", null)).toBe(true);

    expect(getReorderProject("inbox", null)).toBe("Inbox");
    expect(getReorderProject("browse", "Work")).toBe("Work");
    expect(getReorderProject("today", null)).toBeNull();
  });
});
