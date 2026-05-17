import { afterEach, describe, expect, it, vi } from "vitest";
import type { Reminder } from "@/reminders/types/plugin-reminder";
import type { ReminderIndex, IndexedReminder } from "@/reminders/data/reminderIndex";
import type { StorageCompat } from "@/reminders/data/storageCompat";
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
    createdAt: overrides.createdAt || "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt || "2026-01-01T00:00:00.000Z",
    description: overrides.description,
    completedAt: overrides.completedAt,
    fileLink: overrides.fileLink,
    lineNumber: overrides.lineNumber,
  };
}

function makeIndexedReminder(overrides: Partial<IndexedReminder>): IndexedReminder {
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
    filePath: overrides.filePath || "Reminders/Inbox.md",
    lineNumber: overrides.lineNumber ?? 1,
    rawLine: overrides.rawLine || "- [ ] Task",
    contentHash: overrides.contentHash || "hash",
  };
}

function createStorage(overrides: Partial<StorageCompat> = {}): StorageCompat {
  return {
    getAll: () => [],
    getActive: () => [],
    getCompleted: () => [],
    getTodayReminders: () => [],
    getUpcoming: () => [],
    getOverdue: () => [],
    getByProject: () => [],
    getByFile: () => [],
    getById: () => undefined,
    getByIdAsync: async () => undefined,
    getProjects: () => [],
    create: async () => makeReminder({}),
    update: async () => undefined,
    delete: async () => false,
    complete: async () => undefined,
    uncomplete: async () => undefined,
    reorder: async () => {},
    forceSave: async () => {},
    getStats: () => ({ activeCount: 0, completedCount: 0, totalCount: 0 }),
    ...overrides,
  };
}

function createIndex(overrides: Partial<ReminderIndex> = {}): ReminderIndex {
  return {
    isLoaded: true,
    remindersFolderPath: "Reminders",
    getAll: () => [],
    getActive: () => [],
    getCompleted: () => [],
    getToday: () => [],
    getUpcoming: () => [],
    getOverdue: () => [],
    getByProject: () => [],
    getByFile: () => [],
    getById: () => undefined,
    getProjects: () => [],
    load: async () => ({ reminders: [], filesScanned: 0, totalLines: 0, scanDurationMs: 0, discoveredProjects: [] }),
    rescanFile: async () => {},
    removeFile: () => {},
    renameFile: () => {},
    isReminderFile: () => true,
    onIndexChange: () => () => {},
    applyOptimisticCreate: () => {},
    applyOptimisticUpdate: () => {},
    applyOptimisticDelete: () => {},
    clearOptimistic: () => {},
    ...overrides,
  };
}

describe("loadRemindersListData", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("combines today, overdue, and completed-today reminders from the index", async () => {
    const loaded = await loadRemindersListData({
      reminderIndex: createIndex({
        getToday: () => [makeIndexedReminder({ id: "today", dueDate: "2026-01-10" })],
        getOverdue: () => [makeIndexedReminder({ id: "overdue", dueDate: "2026-01-08" })],
        getCompleted: () => [
          makeIndexedReminder({ id: "completed-today", completed: true, dueDate: "2026-01-10" }),
          makeIndexedReminder({ id: "completed-old", completed: true, dueDate: "2026-01-01" }),
        ],
      }),
      storage: createStorage(),
      showToday: true,
      showCompleted: true,
      effectiveDays: 7,
      todayPrefix: "2026-01-10",
    });

    expect(loaded.map((reminder) => reminder.id)).toEqual(["today", "overdue", "completed-today"]);
  });

  it("falls back to storage for upcoming reminders when the index is unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-10T09:00:00.000Z"));

    const upcomingReminder = makeReminder({ id: "upcoming", dueDate: "2026-01-12" });
    const loaded = await loadRemindersListData({
      reminderIndex: createIndex({ isLoaded: false }),
      storage: createStorage({
        getActive: () => [upcomingReminder],
      }),
      showUpcoming: true,
      showCompleted: false,
      effectiveDays: 7,
      todayPrefix: "2026-01-10",
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
