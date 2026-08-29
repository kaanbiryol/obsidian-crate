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
import { requireReminderProjectPath } from "../../core/reminderProjectPath";
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
  const normalizedProject = requireReminderProjectPath(project);
  const normalizedRecurrence = normalizeRecurrenceRule(recurrence);
  const stableReminderId = reminderId ?? createReminderId();
  const file = await context.getOrCreateProjectFile(normalizedProject);

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
    project: normalizedProject,
    recurrence: normalizedRecurrence,
    filePath: file.path,
    lineNumber: -1,
    rawLine: newLine,
    contentHash,
  };

  context.index.applyOptimisticCreate(optimisticReminder);

  try {
    await context.app.vault.process(file, (fileContent) =>
      appendReminderBlockToContent(fileContent, newLine, normalizedDescription)
    );
    markdownWriterLog.info(`Created reminder in ${file.path}`);
    await notifyFileWritten(context, file);

    const reminder: Reminder & { contentHash: string } = {
      id: stableReminderId,
      content,
      dueDate: storedDates.dueDate,
      dueDatetime: storedDates.dueDatetime,
      priority,
      completed: false,
      project: normalizedProject,
      recurrence: normalizedRecurrence,
      contentHash,
    };
    triggerReminderChange(context, reminder, "create");
  } catch (error) {
    context.index.clearOptimistic(stableReminderId);
    throw error;
  }
}
