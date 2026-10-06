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
      const now = new Date();
      return getTodayReminderIds(
        index.getToday(now),
        index.getOverdue(now),
        index.getCompleted(),
        includeCompleted,
        now,
      );
    },

    getProjects() {
      return index.getProjects();
    },
  };
}
