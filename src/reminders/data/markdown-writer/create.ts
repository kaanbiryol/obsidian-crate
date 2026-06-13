import type { Priority, Reminder, RecurrenceRule } from "@/reminders/types/reminder";
import { generateContentHash } from "@/reminders/utils/checkboxParser";
import { calculateFirstOccurrence } from "@/reminders/utils/recurrenceCalculator";
import { rebuildCheckboxLine } from "@/reminders/utils/checkboxParser";
import {
  buildStoredReminderDates,
  inferHasTimeFromDate,
} from "@/reminders/utils/reminderDate";
import { normalizeRecurrenceRule } from "@/reminders/utils/recurrenceRule";
import { createReminderId } from "../../core/reminderIdentity";
import type { IndexedReminder } from "../reminder-index";
import { appendReminderBlockToContent } from "../../core/markdownReminderFile";
import type { MarkdownWriterContext } from "./types";
import {
  markdownWriterLog,
  notifyFileWritten,
  triggerReminderChange,
} from "./operation-shared";

export async function createReminderInMarkdown(
  context: MarkdownWriterContext,
  project: string,
  content: string,
  dueDate: Date | undefined,
  priority: Priority,
  recurrence?: RecurrenceRule,
  hasTime?: boolean,
  reminderId?: string,
  description?: string,
): Promise<void> {
  const normalizedRecurrence = normalizeRecurrenceRule(recurrence);
  const stableReminderId = reminderId ?? createReminderId();
  const file = await context.getOrCreateProjectFile(project);
  const fileContent = await context.app.vault.read(file);

  let effectiveDueDate = dueDate;
  if (normalizedRecurrence && !dueDate) {
    effectiveDueDate = calculateFirstOccurrence(normalizedRecurrence);
  }
  const resolvedHasTime = hasTime ?? inferHasTimeFromDate(effectiveDueDate);
  const storedDates = buildStoredReminderDates(effectiveDueDate, resolvedHasTime);

  const newLine = rebuildCheckboxLine(
    "",
    false,
    content,
    effectiveDueDate,
    priority,
    undefined,
    normalizedRecurrence,
    resolvedHasTime,
    stableReminderId,
  );

  const contentHash = generateContentHash(content);
  const normalizedDescription = description?.trim() || undefined;
  const optimisticReminder: IndexedReminder = {
    id: stableReminderId,
    content,
    description: normalizedDescription,
    dueDate: storedDates.dueDate,
    dueDatetime: storedDates.dueDatetime,
    priority,
    completed: false,
    project,
    recurrence: normalizedRecurrence,
    filePath: file.path,
    lineNumber: -1,
    rawLine: newLine,
    contentHash,
  };

  context.index.applyOptimisticCreate(optimisticReminder);

  const newContent = appendReminderBlockToContent(
    fileContent,
    newLine,
    normalizedDescription,
  );

  try {
    await context.app.vault.modify(file, newContent);
    markdownWriterLog.info(`Created reminder in ${file.path}`);
    await notifyFileWritten(context, file);

    const reminder: Reminder & { contentHash: string } = {
      id: stableReminderId,
      content,
      dueDate: storedDates.dueDate,
      dueDatetime: storedDates.dueDatetime,
      priority,
      completed: false,
      project,
      recurrence: normalizedRecurrence,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      contentHash,
    };
    triggerReminderChange(context, reminder, "create");
  } catch (error) {
    context.index.clearOptimistic(stableReminderId);
    throw error;
  }
}
