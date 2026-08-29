import { afterEach, describe, expect, it, vi } from "vitest";
import type { Reminder } from "@/reminders/types/plugin-reminder";
import type { ReminderRepository } from "@/reminders/data/reminder-repository";
import {
  buildRemindersListPresentation,
  loadRemindersListData,
} from "./reminderListModel";

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
    description: overrides.description,
    fileLink: overrides.fileLink,
    lineNumber: overrides.lineNumber,
  };
}

function createRepository(overrides: Partial<ReminderRepository> = {}): ReminderRepository {
  return {
    getAll: () => [],
    getActive: () => [],
    getTodayReminders: () => [],
    getProjects: () => [],
    create: async () => makeReminder({}),
    update: async () => undefined,
    delete: async () => false,
    complete: async () => undefined,
    uncomplete: async () => undefined,
    reorder: async () => {},
    getStats: () => ({ activeCount: 0, completedCount: 0, totalCount: 0 }),
    ...overrides,
  };
}

describe("loadRemindersListData", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads today reminders through the repository", async () => {
    const todayReminders = [
      makeReminder({ id: "today", dueDate: "2026-01-10" }),
      makeReminder({ id: "overdue", dueDate: "2026-01-08" }),
      makeReminder({ id: "completed-today", completed: true, dueDate: "2026-01-10" }),
    ];
    const loaded = await loadRemindersListData({
      repository: createRepository({
        getTodayReminders: () => todayReminders,
      }),
      showToday: true,
      showCompleted: true,
      effectiveDays: 7,
    });

    expect(loaded.map((reminder) => reminder.id)).toEqual(["today", "overdue", "completed-today"]);
  });

  it("loads upcoming reminders through the repository", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-10T09:00:00.000Z"));

    const upcomingReminder = makeReminder({ id: "upcoming", dueDate: "2026-01-12" });
    const loaded = await loadRemindersListData({
      repository: createRepository({
        getActive: () => [upcomingReminder],
      }),
      showUpcoming: true,
      showCompleted: false,
      effectiveDays: 7,
    });

    expect(loaded).toEqual([upcomingReminder]);
  });
});

describe("buildRemindersListPresentation", () => {
  it("filters project views, preserves file order for reorderable lists, and computes counts", () => {
    const presentation = buildRemindersListPresentation({
      rawReminders: [
        makeReminder({ id: "b", project: "Work", lineNumber: 2 }),
        makeReminder({ id: "a", project: "Work", lineNumber: 1, dueDate: "2026-01-01" }),
        makeReminder({ id: "c", project: "Inbox", completed: true }),
      ],
      projectFilter: "work",
      effectiveDays: 7,
    });

    expect(presentation.supportsReorder).toBe(true);
    expect(presentation.effectiveProject).toBe("work");
    expect(presentation.reminders.map((reminder) => reminder.id)).toEqual(["a", "b"]);
    expect(presentation.activeCount).toBe(2);
    expect(presentation.completedCount).toBe(0);
    expect(presentation.overdueCount).toBe(1);
    expect(presentation.dateGroups).toBeNull();
  });

  it("builds grouped upcoming date sections and empty-state copy", () => {
    const presentation = buildRemindersListPresentation({
      rawReminders: [
        makeReminder({ id: "soon", dueDate: "2026-01-11" }),
        makeReminder({ id: "later", dueDate: "2026-01-12" }),
      ],
      showUpcoming: true,
      effectiveDays: 5,
    });

    expect(presentation.supportsReorder).toBe(false);
    expect(presentation.dateGroups?.map((group) => group.reminders.map((reminder) => reminder.id))).toEqual([
      ["soon"],
      ["later"],
    ]);
    expect(presentation.emptyMessage).toBe("No reminders in the next 5 days");
  });
});
