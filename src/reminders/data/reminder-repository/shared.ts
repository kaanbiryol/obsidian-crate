import type { Priority, Reminder } from "@/reminders/types/plugin-reminder";

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
