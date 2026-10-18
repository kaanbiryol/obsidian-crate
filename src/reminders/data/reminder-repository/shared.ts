import type { IndexedReminder } from "../reminder-index";
import type { Priority, Reminder } from "@/reminders/types/plugin-reminder";
import {
  isReminderDueToday,
} from "@/reminders/utils/reminderDate";
import { toReminder } from "../toReminder";

export function getTodayReminderIds(
  activeToday: IndexedReminder[],
  overdue: IndexedReminder[],
  completed: IndexedReminder[],
  includeCompleted: boolean,
  now: Date,
  convert: (reminder: IndexedReminder) => Reminder = toReminder,
): Reminder[] {
  const combined = new Map<string, IndexedReminder>();
  for (const reminder of [...activeToday, ...overdue]) {
    combined.set(reminder.id, reminder);
  }

  if (includeCompleted) {
    for (const reminder of completed) {
      if (isReminderDueToday(reminder, now)) {
        combined.set(reminder.id, reminder);
      }
    }
  }

  return Array.from(combined.values()).map(convert);
}

export function buildCreatedReminderFallback(params: {
  id: string;
  content: string;
  description?: string;
  project: string;
  priority: Priority;
  recurrence?: Reminder["recurrence"];
  storedDates: { dueDate?: string; dueDatetime?: string };
}): Reminder {
  return {
    id: params.id,
    content: params.content,
    description: params.description,
    dueDate: params.storedDates.dueDate,
    dueDatetime: params.storedDates.dueDatetime,
    priority: params.priority,
    completed: false,
    project: params.project,
    recurrence: params.recurrence,
  };
}
