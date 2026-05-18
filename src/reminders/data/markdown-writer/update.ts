import type { Reminder } from "@/reminders/types/reminder";
import { generateContentHash } from "@/reminders/utils/checkboxParser";
import { rebuildCheckboxLine } from "@/reminders/utils/checkboxParser";
import {
  buildStoredReminderDates,
  inferHasTimeFromDate,
  parseStoredReminderDate,
  reminderHasTime,
} from "@/reminders/utils/reminderDate";
import { normalizeRecurrenceRule } from "@/reminders/utils/recurrenceRule";
import type { IndexedReminder } from "../reminder-index";
import { findReminderLineNumber } from "./helpers";
import {
  buildDescriptionBlock,
  replaceReminderBlockInContent,
} from "../markdownReminderFile";
import type {
  MarkdownWriterContext,
  UpdateReminderInput,
} from "./types";
import { createReminderInMarkdown } from "./create";
import { deleteReminderInMarkdown } from "./delete";
import {
  markdownWriterLog,
  notifyFileWritten,
  triggerReminderChange,
} from "./operation-shared";

export async function updateReminderInMarkdown(
  context: MarkdownWriterContext,
  reminder: IndexedReminder,
  updates: UpdateReminderInput,
): Promise<void> {
  const newProject = updates.project ?? reminder.project;
  const oldProject = reminder.project || "Inbox";
  const newRecurrence = Object.prototype.hasOwnProperty.call(updates, "recurrence")
    ? normalizeRecurrenceRule(updates.recurrence ?? undefined)
    : normalizeRecurrenceRule(reminder.recurrence);
  const currentDueDate = parseStoredReminderDate(reminder);
  const currentHasTime = reminderHasTime(reminder);
  const newHasTime = Object.prototype.hasOwnProperty.call(updates, "hasTime")
    ? updates.hasTime
    : ("dueDate" in updates ? inferHasTimeFromDate(updates.dueDate) : currentHasTime);

  if (newProject && newProject !== oldProject) {
    markdownWriterLog.info(`Moving reminder from ${oldProject} to ${newProject}`);
    const newContent = updates.content ?? reminder.content;
    const newDueDate = "dueDate" in updates ? updates.dueDate : currentDueDate;
    const newPriority = updates.priority ?? reminder.priority;
    const movedDescription = "description" in updates
      ? updates.description
      : reminder.description;

    await deleteReminderInMarkdown(context, reminder);
    await createReminderInMarkdown(
      context,
      newProject,
      newContent,
      newDueDate,
      newPriority,
      newRecurrence,
      newHasTime,
      reminder.id,
      movedDescription,
    );
    return;
  }

  const file = await context.getFile(reminder.filePath);
  if (!file) {
    throw new Error(`File not found: ${reminder.filePath}`);
  }

  const fileContent = await context.app.vault.read(file);
  const lines = fileContent.split("\n");
  const lineNumber = findReminderLineNumber(lines, reminder);
  if (lineNumber === -1) {
    throw new Error(
      `Cannot safely locate reminder line in ${reminder.filePath}. The file may have been modified.`,
    );
  }

  const newContent = updates.content ?? reminder.content;
  const newDueDate = "dueDate" in updates ? updates.dueDate : currentDueDate;
  const newPriority = updates.priority ?? reminder.priority;
  const storedDates = buildStoredReminderDates(newDueDate, newHasTime);
  const newDescription = "description" in updates
    ? (updates.description?.trim() || undefined)
    : reminder.description;
  const newDescLines = buildDescriptionBlock(newDescription);

  context.index.applyOptimisticUpdate(reminder.id, {
    content: newContent,
    description: newDescription,
    dueDate: storedDates.dueDate,
    dueDatetime: storedDates.dueDatetime,
    priority: newPriority,
    recurrence: newRecurrence,
  });

  const indentMatch = reminder.rawLine.match(/^(\s*)/);
  const indentation = indentMatch ? indentMatch[1] : "";
  const newLine = rebuildCheckboxLine(
    indentation,
    reminder.completed,
    newContent,
    newDueDate,
    newPriority,
    undefined,
    newRecurrence,
    newHasTime,
    reminder.id,
  );

  const replacement = replaceReminderBlockInContent(
    fileContent,
    reminder,
    [newLine, ...newDescLines],
  );

  try {
    await context.app.vault.modify(file, replacement.content);
    markdownWriterLog.info(`Updated reminder in ${reminder.filePath} at line ${replacement.lineNumber}`);
    await notifyFileWritten(context, file);

    const contentHash = generateContentHash(newContent);
    const updatedReminder: Reminder & { contentHash: string } = {
      id: reminder.id,
      content: newContent,
      dueDate: storedDates.dueDate,
      dueDatetime: storedDates.dueDatetime,
      priority: newPriority,
      completed: reminder.completed,
      project: newProject || "Inbox",
      recurrence: newRecurrence,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      contentHash,
    };
    triggerReminderChange(context, updatedReminder, "update");
  } catch (error) {
    context.index.clearOptimistic(reminder.id);
    throw error;
  }
}
