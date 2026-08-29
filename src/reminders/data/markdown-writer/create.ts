import type { Priority, Reminder, RecurrenceRule } from "@/reminders/types/reminder";
import { generateContentHash } from "@/reminders/utils/checkboxParser";
import { createReminderId } from "../../core/reminderIdentity";
import type { IndexedReminder } from "../reminder-index";
import {
  appendCreatedReminderBlock,
  buildCreatedReminderBlock,
} from "../../core/markdownReminderMutation";
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
  const stableReminderId = reminderId ?? createReminderId();
  const file = await context.getOrCreateProjectFile(normalizedProject);
  const mutation = buildCreatedReminderBlock({
    content,
    description,
    dueDate,
    priority,
    recurrence,
    hasTime,
    reminderId: stableReminderId,
  });

  const contentHash = generateContentHash(content);
  const optimisticReminder: IndexedReminder = {
    id: stableReminderId,
    content,
    description: mutation.description,
    dueDate: mutation.dueDateKey,
    dueDatetime: mutation.dueDatetime,
    priority,
    completed: false,
    project: normalizedProject,
    recurrence: mutation.recurrence,
    filePath: file.path,
    lineNumber: -1,
    rawLine: mutation.checkboxLine,
    contentHash,
  };

  context.index.applyOptimisticCreate(optimisticReminder);

  try {
    await context.app.vault.process(file, (fileContent) =>
      appendCreatedReminderBlock(fileContent, mutation)
    );
    markdownWriterLog.info(`Created reminder in ${file.path}`);
    await notifyFileWritten(context, file);

    const reminder: Reminder & { contentHash: string } = {
      id: stableReminderId,
      content,
      dueDate: mutation.dueDateKey,
      dueDatetime: mutation.dueDatetime,
      priority,
      completed: false,
      project: normalizedProject,
      recurrence: mutation.recurrence,
      contentHash,
    };
    triggerReminderChange(context, reminder, "create");
  } catch (error) {
    context.index.clearOptimistic(stableReminderId);
    throw error;
  }
}
