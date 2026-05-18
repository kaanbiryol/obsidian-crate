import type { StorageCompatContext } from "./types";
import { getTodayReminderIds, toReminder } from "./shared";

export function createStorageCompatQueries({ index }: StorageCompatContext) {
  return {
    getAll() {
      return index.getAll().map(toReminder);
    },

    getActive() {
      return index.getActive().map(toReminder);
    },

    getCompleted() {
      return index.getCompleted().map(toReminder);
    },

    getTodayReminders(includeCompleted = false) {
      return getTodayReminderIds(
        index.getToday(),
        index.getOverdue(),
        index.getCompleted(),
        includeCompleted,
      );
    },

    getUpcoming(days = 7) {
      return index.getUpcoming(days).map(toReminder);
    },

    getOverdue() {
      return index.getOverdue().map(toReminder);
    },

    getByProject(project: string) {
      return index.getByProject(project).map(toReminder);
    },

    getByFile(filePath: string) {
      return index.getByFile(filePath).map(toReminder);
    },

    getById(id: string) {
      const indexed = index.getById(id);
      return indexed ? toReminder(indexed) : undefined;
    },

    async getByIdAsync(id: string) {
      const indexed = index.getById(id);
      return indexed ? toReminder(indexed) : undefined;
    },

    getProjects() {
      return index.getProjects();
    },

    getStats() {
      const active = index.getActive();
      const completed = index.getCompleted();
      return {
        activeCount: active.length,
        completedCount: completed.length,
        totalCount: active.length + completed.length,
      };
    },
  };
}
