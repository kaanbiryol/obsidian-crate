import type { UpdateReminderInput } from '../../core/reminderMutationPlan';
import { processVaultMarkdown, readVaultMarkdown } from '../vault-markdown';
import type { IndexedReminder } from "../reminder-index";
import {
  appendReminderBlockToContent,
  deleteReminderBlockFromContent,
  findReminderLineNumber,
} from "../../core/markdownReminderFile";
import {
  buildMovedReminderBlock,
  buildUpdatedReminderBlock,
  reminderBlockFields,
  replaceUpdatedReminderBlock,
} from "../../core/markdownReminderMutation";
import { normalizeReminderProjectPath, reminderProject } from "../../core/reminderProjectPath";
import type {
  MarkdownWriterContext,
} from "./types";
import { markdownWriterLog } from "./helpers";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function rollbackDestinationReminder(
  context: MarkdownWriterContext,
  file: Awaited<ReturnType<MarkdownWriterContext["getOrCreateProjectFile"]>>,
  reminder: IndexedReminder,
): Promise<void> {
  let removed = false;
  await processVaultMarkdown(context.app, file, (fileContent) => {
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
  const oldProject = reminderProject(reminder);

  if (newProject && newProject !== oldProject) {
    markdownWriterLog.info(`Moving reminder from ${oldProject} to ${newProject}`);
    const movedMutation = buildMovedReminderBlock(reminder, updates);

    const oldFile = await context.getFile(reminder.filePath);
    if (!oldFile) {
      throw new Error(`File not found: ${reminder.filePath}`);
    }
    // Check the source block can be removed before writing anything, as the
    // shared web command does. Nested tasks or supporting text reject the move
    // here instead of leaving the reminder in both notes.
    if (!deleteReminderBlockFromContent(await readVaultMarkdown(context.app, oldFile), reminder).found) {
      throw new Error(`Cannot safely locate reminder line in ${reminder.filePath}. The file may have been modified.`);
    }

    const newFile = await context.getOrCreateProjectFile(newProject);
    const movedReminder: IndexedReminder = {
      ...reminder,
      ...reminderBlockFields(movedMutation),
      completed: reminder.completed,
      project: newProject,
      filePath: newFile.path,
      lineNumber: -1,
      rawLine: movedMutation.checkboxLine,
    };

    context.index.applyOptimisticUpdate(reminder.id, movedReminder);

    const applyMove = async () => {
      let destinationWritten = false;
      try {
      await processVaultMarkdown(context.app, newFile, (fileContent) => {
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

      await processVaultMarkdown(context.app, oldFile, (fileContent) => {
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
        context.index.rescanFile(newFile),
        context.index.rescanFile(oldFile),
      ]);

    } catch (error) {
      context.index.clearOptimistic(reminder.id);
      throw error;
    }
    return;
  }

  const mutation = buildUpdatedReminderBlock(reminder, updates);
  const file = await context.getFile(reminder.filePath);
  if (!file) {
    throw new Error(`File not found: ${reminder.filePath}`);
  }

  context.index.applyOptimisticUpdate(reminder.id, reminderBlockFields(mutation));

  try {
    let replacementLineNumber = -1;
    await processVaultMarkdown(context.app, file, (fileContent) => {
      context.moveJournal?.assertActive();
      const replacement = replaceUpdatedReminderBlock(fileContent, reminder, mutation);
      replacementLineNumber = replacement.lineNumber;
      return replacement.content;
    });
    markdownWriterLog.info(`Updated reminder in ${reminder.filePath} at line ${replacementLineNumber}`);
    await context.index.rescanFile(file);

  } catch (error) {
    context.index.clearOptimistic(reminder.id);
    throw error;
  }
}
