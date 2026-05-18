import { reorderReminderBlocksInContent } from "../markdownReminderFile";
import type { MarkdownWriterContext } from "./types";
import { markdownWriterLog } from "./operation-shared";

export async function reorderRemindersInMarkdown(
  context: MarkdownWriterContext,
  filePath: string,
  orderedIds: string[],
): Promise<void> {
  const file = await context.getFile(filePath);
  if (!file) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileContent = await context.app.vault.read(file);
  await context.app.vault.modify(file, reorderReminderBlocksInContent(fileContent, orderedIds));
  markdownWriterLog.info(`Reordered reminders in ${filePath}`);
}
