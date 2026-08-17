import { deleteReminderBlockFromContent } from "../../core/markdownReminderFile";
import type { IndexedReminder } from "../reminder-index";
import { toReminder } from "./helpers";
import type { MarkdownWriterContext } from "./types";
import {
  markdownWriterLog,
  notifyFileWritten,
  triggerReminderChange,
} from "./operation-shared";

export async function deleteReminderInMarkdown(
  context: MarkdownWriterContext,
  reminder: IndexedReminder,
): Promise<void> {
  const file = await context.getFile(reminder.filePath);
  if (!file) {
    throw new Error(`File not found: ${reminder.filePath}`);
  }

  context.index.applyOptimisticDelete(reminder.id);

  try {
    let deletedLineNumber = -1;
    await context.app.vault.process(file, (fileContent) => {
      const deletion = deleteReminderBlockFromContent(fileContent, reminder);
      deletedLineNumber = deletion.lineNumber;
      return deletion.content;
    });

    if (deletedLineNumber === -1) {
      markdownWriterLog.warn(" Reminder line not found, may already be deleted");
      context.index.clearOptimistic(reminder.id);
      return;
    }

    markdownWriterLog.info(`Deleted reminder from ${reminder.filePath} at line ${deletedLineNumber}`);
    await notifyFileWritten(context, file);
    triggerReminderChange(context, toReminder(reminder), "delete");
  } catch (error) {
    context.index.clearOptimistic(reminder.id);
    throw error;
  }
}
