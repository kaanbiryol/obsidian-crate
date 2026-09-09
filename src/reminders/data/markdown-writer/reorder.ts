import { processVaultMarkdown } from '../vault-markdown';
import { reorderReminderBlocksInContent } from "../../core/markdownReminderFile";
import type { MarkdownWriterContext } from "./types";
import { markdownWriterLog, notifyFileWritten } from "./operation-shared";

export async function reorderRemindersInMarkdown(
  context: MarkdownWriterContext,
  filePath: string,
  orderedIds: string[],
): Promise<void> {
  const file = await context.getFile(filePath);
  if (!file) {
    throw new Error(`File not found: ${filePath}`);
  }

  await processVaultMarkdown(context.app, file, (fileContent) => {
    context.moveJournal?.assertActive();
    return reorderReminderBlocksInContent(fileContent, orderedIds);
  });
  await notifyFileWritten(context, file);
  markdownWriterLog.info(`Reordered reminders in ${filePath}`);
}
