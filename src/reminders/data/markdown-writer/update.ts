import { generateContentHash } from "@/reminders/utils/checkboxParser";
import type { IndexedReminder } from "../reminder-index";
import { findReminderLineNumber } from "./helpers";
import {
  appendReminderBlockToContent,
  deleteReminderBlockFromContent,
} from "../../core/markdownReminderFile";
import {
  buildCreatedReminderBlock,
  buildUpdatedReminderBlock,
  replaceUpdatedReminderBlock,
} from "../../core/markdownReminderMutation";
import { normalizeReminderProjectPath } from "../../core/reminderProjectPath";
import type {
  MarkdownWriterContext,
  UpdateReminderInput,
} from "./types";
import {
  markdownWriterLog,
  notifyFileWritten,
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
    context.moveJournal?.assertActive();
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
  const mutation = buildUpdatedReminderBlock(reminder, updates);

  if (newProject && newProject !== oldProject) {
    markdownWriterLog.info(`Moving reminder from ${oldProject} to ${newProject}`);
    const movedMutation = buildCreatedReminderBlock({
      content: mutation.content,
      description: mutation.description,
      dueDate: mutation.dueDate,
      priority: mutation.priority,
      recurrence: mutation.recurrence,
      hasTime: mutation.hasTime,
      completed: reminder.completed,
      reminderId: reminder.id,
    });

    const oldFile = await context.getFile(reminder.filePath);
    if (!oldFile) {
      throw new Error(`File not found: ${reminder.filePath}`);
    }

    const newFile = await context.getOrCreateProjectFile(newProject);
    const movedReminder: IndexedReminder = {
      ...reminder,
      content: movedMutation.content,
      description: movedMutation.description,
      dueDate: movedMutation.dueDateKey,
      dueDatetime: movedMutation.dueDatetime,
      priority: movedMutation.priority,
      completed: reminder.completed,
      project: newProject,
      recurrence: movedMutation.recurrence,
      filePath: newFile.path,
      lineNumber: -1,
      rawLine: movedMutation.checkboxLine,
      contentHash: generateContentHash(movedMutation.content),
    };

    context.index.applyOptimisticUpdate(reminder.id, movedReminder);

    const applyMove = async () => {
      let destinationWritten = false;
      try {
      await context.app.vault.process(newFile, (fileContent) => {
        context.moveJournal?.assertActive();
        if (findReminderLineNumber(fileContent.split("\n"), movedReminder) !== -1) {
          throw new Error(`Reminder ${reminder.id} already exists in ${newFile.path}`);
        }
        return appendReminderBlockToContent(
          fileContent,
          movedMutation.checkboxLine,
          movedMutation.description,
        );
      });
      destinationWritten = true;

      await context.app.vault.process(oldFile, (fileContent) => {
        context.moveJournal?.assertActive();
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
      context.moveJournal?.assertActive();
      // A durable source write may have succeeded before its acknowledgement
      // failed. The journal reconciles both notes; deleting the destination here
      // could remove the only remaining Markdown copy.
      if (destinationWritten && !context.moveJournal) {
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
    };
    try {
      if (context.moveJournal) await context.moveJournal.execute(reminder, movedReminder, applyMove);
      else await applyMove();
    } catch (error) {
      context.index.clearOptimistic(reminder.id);
      throw error;
    }

    try {
      await Promise.all([
        notifyFileWritten(context, newFile),
        notifyFileWritten(context, oldFile),
      ]);

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

  context.index.applyOptimisticUpdate(reminder.id, {
    content: mutation.content,
    description: mutation.description,
    dueDate: mutation.dueDateKey,
    dueDatetime: mutation.dueDatetime,
    priority: mutation.priority,
    recurrence: mutation.recurrence,
  });

  try {
    let replacementLineNumber = -1;
    await context.app.vault.process(file, (fileContent) => {
      context.moveJournal?.assertActive();
      const replacement = replaceUpdatedReminderBlock(fileContent, reminder, mutation);
      replacementLineNumber = replacement.lineNumber;
      return replacement.content;
    });
    markdownWriterLog.info(`Updated reminder in ${reminder.filePath} at line ${replacementLineNumber}`);
    await notifyFileWritten(context, file);

  } catch (error) {
    context.index.clearOptimistic(reminder.id);
    throw error;
  }
}
