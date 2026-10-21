import { compareProjects } from "@/reminders/core/reminder-list";
import type { IndexedReminder } from "./index";

export interface ReminderLookupStore {
  rebuild(reminders: IndexedReminder[]): void;
  removeFile(filePath: string): IndexedReminder[];
  addReminders(reminders: IndexedReminder[]): void;
  getById(id: string): IndexedReminder | undefined;
  getByFile(filePath: string): IndexedReminder[];
  getProjects(discoveredProjects: Set<string>): string[];
}

export function createReminderLookupStore(): ReminderLookupStore {
  let byId = new Map<string, IndexedReminder>();
  let byFile = new Map<string, IndexedReminder[]>();
  let projectCounts = new Map<string, number>();

  function addReminder(reminder: IndexedReminder): void {
    byId.set(reminder.id, reminder);

    const fileReminders = byFile.get(reminder.filePath) || [];
    fileReminders.push(reminder);
    byFile.set(reminder.filePath, fileReminders);

    if (!reminder.project) {
      return;
    }

    projectCounts.set(reminder.project, (projectCounts.get(reminder.project) ?? 0) + 1);
  }

  function removeReminderFromProject(reminder: IndexedReminder): void {
    if (!reminder.project) {
      return;
    }

    const count = projectCounts.get(reminder.project) ?? 0;
    if (count > 1) {
      projectCounts.set(reminder.project, count - 1);
    } else {
      projectCounts.delete(reminder.project);
    }
  }

  return {
    rebuild(reminders: IndexedReminder[]) {
      byId = new Map();
      byFile = new Map();
      projectCounts = new Map();

      for (const reminder of reminders) {
        addReminder(reminder);
      }
    },

    removeFile(filePath: string) {
      const removedReminders = byFile.get(filePath) || [];
      for (const reminder of removedReminders) {
        byId.delete(reminder.id);
        removeReminderFromProject(reminder);
      }

      byFile.delete(filePath);
      return removedReminders;
    },

    addReminders(reminders: IndexedReminder[]) {
      for (const reminder of reminders) {
        addReminder(reminder);
      }
    },

    getById(id: string) {
      return byId.get(id);
    },

    getByFile(filePath: string) {
      return byFile.get(filePath) || [];
    },

    getProjects(discoveredProjects: Set<string>) {
      return Array.from(new Set([...projectCounts.keys(), ...discoveredProjects])).sort(compareProjects);
    },
  };
}
