import { assertReminderMutationInput } from './reminderMutationInput';
import type { MarkdownReminderUpdate } from './markdownReminderMutation';
import type { Priority, Reminder, UpdateReminderParams } from '../types/reminder';
import { buildStoredReminderDates, parseReminderDateValue } from '../utils/reminderDate';
import { normalizeRecurrenceRule } from '../utils/recurrenceRule';

/** Normalized domain input consumed by both Obsidian and server Markdown writers. */
export interface UpdateReminderInput extends MarkdownReminderUpdate { project?: string }

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
  assertReminderMutationInput(params, "create");
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

export function buildReminderUpdate(
  params: UpdateReminderParams,
): {
  updates: UpdateReminderInput;
  recurrenceUpdate?: Reminder["recurrence"] | null;
  hasRecurrenceUpdate: boolean;
  hasDueDateUpdate: boolean;
  storedDates: { dueDate?: string; dueDatetime?: string };
} {
  assertReminderMutationInput(params, "update");
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

  const updates: UpdateReminderInput = {
    content: params.content,
    ...(Object.prototype.hasOwnProperty.call(params, 'description') ? { description: params.description } : {}),
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
