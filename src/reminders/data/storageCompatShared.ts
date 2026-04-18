import type { MarkdownWriter } from "./markdownWriter";
import type { IndexedReminder } from "./reminderIndex";
import type { Priority, Reminder, UpdateReminderParams } from "@/reminders/types/plugin-reminder";
import {
  buildStoredReminderDates,
  formatLocalDateKey,
  parseReminderDateValue,
} from "@/reminders/utils/reminderDate";
import { normalizeRecurrenceRule } from "@/reminders/utils/recurrenceRule";

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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lineNumber: indexed.lineNumber,
  };
}

export function getTodayReminderIds(
  activeToday: IndexedReminder[],
  overdue: IndexedReminder[],
  completed: IndexedReminder[],
  includeCompleted: boolean,
): Reminder[] {
  const combined = new Map<string, IndexedReminder>();
  for (const reminder of [...activeToday, ...overdue]) {
    combined.set(reminder.id, reminder);
  }

  if (includeCompleted) {
    const today = formatLocalDateKey(new Date());
    for (const reminder of completed) {
      const dueDate = reminder.dueDatetime
        ? formatLocalDateKey(new Date(reminder.dueDatetime))
        : reminder.dueDate;
      if (dueDate === today) {
        combined.set(reminder.id, reminder);
      }
    }
  }

  return Array.from(combined.values()).map(toReminder);
}

export function buildCreateReminderArgs(params: {
  content: string;
  project?: string;
  priority?: Priority;
  recurrence?: Reminder["recurrence"];
  dueDate?: string;
  dueDatetime?: string;
  description?: string;
  id?: string;
}) {
  const project = params.project || "Inbox";
  const reminderId = params.id?.trim();
  const recurrence = normalizeRecurrenceRule(params.recurrence);
  const dueDate = parseReminderDateValue(
    params.dueDatetime ?? params.dueDate,
    Boolean(params.dueDatetime),
  );
  const priority: Priority = params.priority ?? 4;
  const storedDates = buildStoredReminderDates(
    dueDate,
    params.dueDatetime ? true : params.dueDate ? false : undefined,
  );

  return {
    project,
    reminderId,
    recurrence,
    dueDate,
    priority,
    storedDates,
    hasTime: params.dueDatetime ? true : params.dueDate ? false : undefined,
  };
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function buildReminderUpdate(
  params: UpdateReminderParams,
): {
  updates: Parameters<MarkdownWriter["updateReminder"]>[1];
  recurrenceUpdate?: Reminder["recurrence"] | null;
  hasRecurrenceUpdate: boolean;
  hasDueDateUpdate: boolean;
  storedDates: { dueDate?: string; dueDatetime?: string };
} {
  const hasRecurrenceUpdate = Object.prototype.hasOwnProperty.call(params, "recurrence");
  const recurrenceUpdate = hasRecurrenceUpdate
    ? params.recurrence === null
      ? null
      : normalizeRecurrenceRule(params.recurrence)
    : undefined;

  const hasDueDateUpdate =
    Object.prototype.hasOwnProperty.call(params, "dueDate")
    || Object.prototype.hasOwnProperty.call(params, "dueDatetime");
  const dueDate = hasDueDateUpdate
    ? parseReminderDateValue(params.dueDatetime ?? params.dueDate, Boolean(params.dueDatetime))
    : undefined;
  const storedDates = hasDueDateUpdate
    ? buildStoredReminderDates(
        dueDate,
        params.dueDatetime ? true : params.dueDate ? false : undefined,
      )
    : {};

  const updates: Parameters<MarkdownWriter["updateReminder"]>[1] = {
    content: params.content,
    description: params.description,
    priority: params.priority,
    project: params.project,
    ...(hasRecurrenceUpdate ? { recurrence: recurrenceUpdate } : {}),
  };

  if (hasDueDateUpdate) {
    updates.dueDate = dueDate;
    updates.hasTime = params.dueDatetime ? true : params.dueDate ? false : undefined;
  }

  return {
    updates,
    recurrenceUpdate,
    hasRecurrenceUpdate,
    hasDueDateUpdate,
    storedDates,
  };
}
