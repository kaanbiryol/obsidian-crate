import { processVaultMarkdown } from '../vault-markdown';
import { createReminderId } from "../../core/reminderIdentity";
import type { IndexedReminder } from "../reminder-index";
import {
  appendCreatedReminderBlock,
  buildCreatedReminderBlock,
} from "../../core/markdownReminderMutation";
import { requireReminderProjectPath } from "../../core/reminderProjectPath";
import type { CreateReminderInput, MarkdownWriterContext } from "./types";
import {
  markdownWriterLog,
  notifyFileWritten,
} from "./operation-shared";

export async function createReminderInMarkdown(
  context: MarkdownWriterContext,
  { project, content, dueDate, priority, recurrence, hasTime, reminderId, description }: CreateReminderInput,
): Promise<void> {
  const normalizedProject = requireReminderProjectPath(project);
  const stableReminderId = reminderId ?? createReminderId();
  if (context.index.getById(stableReminderId)) throw new Error('This reminder already exists. Close the draft and refresh to see its saved state.');
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
  };

  context.index.applyOptimisticCreate(optimisticReminder);

  try {
    await processVaultMarkdown(context.app, file, (fileContent) => {
      context.moveJournal?.assertActive();
      // A lost local write acknowledgement must not append the same identity twice.
      if (fileContent.includes(`<!-- crate-id:${stableReminderId} -->`)) {
        throw new Error('This reminder already exists. Close the draft and refresh to see its saved state.');
      }
      return appendCreatedReminderBlock(fileContent, mutation);
    });
    markdownWriterLog.info(`Created reminder in ${file.path}`);
    await notifyFileWritten(context, file);

  } catch (error) {
    context.index.clearOptimistic(stableReminderId);
    throw error;
  }
}
