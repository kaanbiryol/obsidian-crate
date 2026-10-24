import { processVaultMarkdown } from '../vault-markdown';
import { createReminderId, extractReminderId } from "../../core/reminderIdentity";
import { markdownTaskContexts } from "../../core/markdownTaskContext";
import type { IndexedReminder } from "../reminder-index";
import {
  appendCreatedReminderBlock,
  buildCreatedReminderBlock,
  reminderBlockFields,
} from "../../core/markdownReminderMutation";
import { requireReminderProjectPath } from "../../core/reminderProjectPath";
import type { CreateReminderInput, MarkdownWriterContext } from "./types";
import { markdownWriterLog } from "./helpers";

/** Checks the task lines the scanner reads, so a marker quoted in a code fence
 * is not an existing reminder. Any marked task line counts, even one the
 * scanner cannot parse yet, so a retry never appends a second copy. */
function containsReminderId(content: string, id: string): boolean {
  const lines = content.split("\n");
  for (const index of markdownTaskContexts(lines).keys()) {
    if (extractReminderId(lines[index]!) === id) return true;
  }
  return false;
}

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
    ...reminderBlockFields(mutation),
    completed: false,
    project: normalizedProject,
    filePath: file.path,
    lineNumber: -1,
    rawLine: mutation.checkboxLine,
  };

  context.index.applyOptimisticCreate(optimisticReminder);

  try {
    await processVaultMarkdown(context.app, file, (fileContent) => {
      context.moveJournal?.assertActive();
      // A lost local write acknowledgement must not append the same identity twice.
      if (containsReminderId(fileContent, stableReminderId)) {
        throw new Error('This reminder already exists. Close the draft and refresh to see its saved state.');
      }
      return appendCreatedReminderBlock(fileContent, mutation);
    });
    markdownWriterLog.info(`Created reminder in ${file.path}`);
    await context.index.rescanFile(file);

  } catch (error) {
    context.index.clearOptimistic(stableReminderId);
    throw error;
  }
}
