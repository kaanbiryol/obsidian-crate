import { deleteReminderBlockFromContent } from "./markdownReminderFile";
import type { IndexedReminder } from "./reminderIndex";
import { toReminder } from "./markdownWriterHelpers";
import type { MarkdownWriterContext } from "./markdownWriterTypes";
import {
  markdownWriterLog,
  notifyFileWritten,
  triggerReminderChange,
} from "./markdownWriterOperationShared";

export async function deleteReminderInMarkdown(
  context: MarkdownWriterContext,
  reminder: IndexedReminder,
): Promise<void> {
  const file = await context.getFile(reminder.filePath);
  if (!file) {
    throw new Error(`File not found: ${reminder.filePath}`);
  }

  context.index.applyOptimisticDelete(reminder.id);

  const fileContent = await context.app.vault.read(file);
  const deletion = deleteReminderBlockFromContent(fileContent, reminder);
  if (!deletion.found) {
    markdownWriterLog.warn(" Reminder line not found, may already be deleted");
    context.index.clearOptimistic(reminder.id);
    return;
  }

  try {
    await context.app.vault.modify(file, deletion.content);
    markdownWriterLog.info(`Deleted reminder from ${reminder.filePath} at line ${deletion.lineNumber}`);
    await notifyFileWritten(context, file);
    triggerReminderChange(context, toReminder(reminder), "delete");
  } catch (error) {
    context.index.clearOptimistic(reminder.id);
    throw error;
  }
}
