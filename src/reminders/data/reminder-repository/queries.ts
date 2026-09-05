import type { ReminderRepositoryContext } from "./types";
import { getTodayReminderIds } from "./shared";
import { toReminder } from "../toReminder";

export function createReminderRepositoryQueries({ index }: ReminderRepositoryContext) {
  return {
    getAll() {
      return index.getAll().map(toReminder);
    },

    getActive() {
      return index.getActive().map(toReminder);
    },

    getTodayReminders(includeCompleted = false) {
      return getTodayReminderIds(
        index.getToday(),
        index.getOverdue(),
        index.getCompleted(),
        includeCompleted,
      );
    },

    getProjects() {
      return index.getProjects();
    },
  };
}
