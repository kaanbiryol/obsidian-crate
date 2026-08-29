import type { IndexedReminder } from "./reminder-index";
import type { Reminder } from "@/reminders/types/reminder";
import { normalizeRecurrenceRule } from "@/reminders/utils/recurrenceRule";

/** Convert the persisted Markdown representation into the UI-facing reminder model. */
export function toReminder(indexed: IndexedReminder): Reminder {
  return {
    id: indexed.id,
    content: indexed.content,
    description: indexed.description,
    dueDate: indexed.dueDate,
    dueDatetime: indexed.dueDatetime,
    priority: indexed.priority,
    completed: indexed.completed,
    project: indexed.project || "Inbox",
    recurrence: normalizeRecurrenceRule(indexed.recurrence),
    lineNumber: indexed.lineNumber,
  };
}
