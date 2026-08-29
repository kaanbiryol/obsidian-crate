import type { Reminder } from "@/reminders/types/reminder";
import { generateContentHash } from "@/reminders/utils/checkboxParser";
import { rebuildCheckboxLine } from "@/reminders/utils/checkboxParser";
import { calculateFirstOccurrence } from "@/reminders/utils/recurrenceCalculator";
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
  appendReminderBlockToContent,
  buildDescriptionBlock,
  deleteReminderBlockFromContent,
  replaceReminderBlockInContent,
} from "../../core/markdownReminderFile";
import { normalizeReminderProjectPath } from "../../core/reminderProjectPath";
import type {
  MarkdownWriterContext,
  UpdateReminderInput,
} from "./types";
import {
  markdownWriterLog,
  notifyFileWritten,
  triggerReminderChange,
} from "./operation-shared";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function rollbackDestinationReminder(
  context: MarkdownWriterContext,
  file: Awaited<ReturnType<MarkdownWriterContext["getOrCreateProjectFile"]>>,
  reminder: IndexedReminder,
): Promise<void> {
  let removed = false;
  await context.app.vault.process(file, (fileContent) => {
    const deletion = deleteReminderBlockFromContent(fileContent, reminder);
    removed = deletion.found;
    return deletion.content;
  });

  if (!removed) {
    throw new Error(`Cannot locate the destination copy in ${file.path}`);
  }
}

export async function updateReminderInMarkdown(
  context: MarkdownWriterContext,
  reminder: IndexedReminder,
  updates: UpdateReminderInput,
): Promise<void> {
  const requestedProject = updates.project ?? reminder.project;
  const newProject = requestedProject
    ? normalizeReminderProjectPath(requestedProject)
    : requestedProject;
  if (requestedProject && !newProject) {
    throw new Error(`Invalid reminder project: ${requestedProject}`);
  }
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
    const normalizedDescription = movedDescription?.trim() || undefined;
    const effectiveDueDate = newRecurrence && !newDueDate
      ? calculateFirstOccurrence(newRecurrence)
      : newDueDate;
    const resolvedHasTime = newHasTime ?? inferHasTimeFromDate(effectiveDueDate);
    const storedDates = buildStoredReminderDates(effectiveDueDate, resolvedHasTime);

    const oldFile = await context.getFile(reminder.filePath);
    if (!oldFile) {
      throw new Error(`File not found: ${reminder.filePath}`);
    }

    const newFile = await context.getOrCreateProjectFile(newProject);
    const newLine = rebuildCheckboxLine(
      "",
      reminder.completed,
      newContent,
      effectiveDueDate,
      newPriority,
      undefined,
      newRecurrence,
      resolvedHasTime,
      reminder.id,
    );
    const movedReminder: IndexedReminder = {
      ...reminder,
      content: newContent,
      description: normalizedDescription,
      dueDate: storedDates.dueDate,
      dueDatetime: storedDates.dueDatetime,
      priority: newPriority,
      completed: reminder.completed,
      project: newProject,
      recurrence: newRecurrence,
      filePath: newFile.path,
      lineNumber: -1,
      rawLine: newLine,
      contentHash: generateContentHash(newContent),
    };

    context.index.applyOptimisticUpdate(reminder.id, movedReminder);

    let destinationWritten = false;
    try {
      await context.app.vault.process(newFile, (fileContent) => {
        if (findReminderLineNumber(fileContent.split("\n"), movedReminder) !== -1) {
          throw new Error(`Reminder ${reminder.id} already exists in ${newFile.path}`);
        }
        return appendReminderBlockToContent(fileContent, newLine, normalizedDescription);
      });
      destinationWritten = true;

      await context.app.vault.process(oldFile, (fileContent) => {
        const deletion = deleteReminderBlockFromContent(fileContent, reminder);
        if (!deletion.found) {
          throw new Error(
            `Cannot safely locate reminder line in ${reminder.filePath}. The file may have been modified.`,
          );
        }
        return deletion.content;
      });
    } catch (error) {
      context.index.clearOptimistic(reminder.id);
      if (destinationWritten) {
        try {
          await rollbackDestinationReminder(context, newFile, movedReminder);
        } catch (rollbackError) {
          throw new Error(
            `${errorMessage(error)} Destination rollback also failed: ${errorMessage(rollbackError)}`,
          );
        }
      }
      throw error;
    }

    try {
      await Promise.all([
        notifyFileWritten(context, newFile),
        notifyFileWritten(context, oldFile),
      ]);

      const updatedReminder: Reminder & { contentHash: string } = {
        id: reminder.id,
        content: newContent,
        description: normalizedDescription,
        dueDate: storedDates.dueDate,
        dueDatetime: storedDates.dueDatetime,
        priority: newPriority,
        completed: reminder.completed,
        project: newProject,
        recurrence: newRecurrence,
        contentHash: movedReminder.contentHash,
      };
      triggerReminderChange(context, updatedReminder, "update");
    } catch (error) {
      context.index.clearOptimistic(reminder.id);
      throw error;
    }
    return;
  }

  const file = await context.getFile(reminder.filePath);
  if (!file) {
    throw new Error(`File not found: ${reminder.filePath}`);
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

  try {
    let replacementLineNumber = -1;
    await context.app.vault.process(file, (fileContent) => {
      const replacement = replaceReminderBlockInContent(
        fileContent,
        reminder,
        [newLine, ...newDescLines],
      );
      if (!replacement.found) {
        throw new Error(
          `Cannot safely locate reminder line in ${reminder.filePath}. The file may have been modified.`,
        );
      }
      replacementLineNumber = replacement.lineNumber;
      return replacement.content;
    });
    markdownWriterLog.info(`Updated reminder in ${reminder.filePath} at line ${replacementLineNumber}`);
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
      contentHash,
    };
    triggerReminderChange(context, updatedReminder, "update");
  } catch (error) {
    context.index.clearOptimistic(reminder.id);
    throw error;
  }
}
