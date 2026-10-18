import type { ReminderRepositoryContext } from "./types";
import { getTodayReminderIds } from "./shared";
import { toReminder } from "../toReminder";
import type { IndexedReminder } from "../reminder-index";
import type { Reminder } from "@/reminders/types/reminder";
import { isReminderDueToday, isReminderOverdue } from "@/reminders/utils/reminderDate";

/** Converted reminders keep their identity while the indexed record is
 * unchanged, so memoized rows skip rendering after edits to other notes. The
 * index can update a record in place (a file move), so fields are compared too. */
const CONVERTED_FIELDS = ['id', 'content', 'description', 'dueDate', 'dueDatetime', 'priority', 'completed', 'project', 'recurrence', 'lineNumber'] as const;

export function createReminderRepositoryQueries({ index }: ReminderRepositoryContext) {
  const converted = new WeakMap<IndexedReminder, { source: Pick<IndexedReminder, typeof CONVERTED_FIELDS[number]>; reminder: Reminder }>();
  const convert = (indexed: IndexedReminder): Reminder => {
    const cached = converted.get(indexed);
    if (cached && CONVERTED_FIELDS.every(field => cached.source[field] === indexed[field])) return cached.reminder;
    const reminder = toReminder(indexed);
    converted.set(indexed, { source: Object.fromEntries(CONVERTED_FIELDS.map(field => [field, indexed[field]])) as Pick<IndexedReminder, typeof CONVERTED_FIELDS[number]>, reminder });
    return reminder;
  };
  return {
    getAll() {
      return index.getAll().map(convert);
    },

    getActive() {
      return index.getActive().map(convert);
    },

    getTodayReminders(includeCompleted = false) {
      const now = new Date();
      // One merged index read instead of three, with the shared converted rows.
      const activeToday: IndexedReminder[] = [], overdue: IndexedReminder[] = [], completed: IndexedReminder[] = [];
      for (const reminder of index.getAll()) {
        if (!reminder.completed && isReminderDueToday(reminder, now)) activeToday.push(reminder);
        if (isReminderOverdue(reminder, now)) overdue.push(reminder);
        if (reminder.completed) completed.push(reminder);
      }
      return getTodayReminderIds(activeToday, overdue, completed, includeCompleted, now, convert);
    },

    getProjects() {
      return index.getProjects();
    },
  };
}
