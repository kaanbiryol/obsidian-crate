import {
  createLogger,
  type Reminder,
} from "@/reminders";
import type {
  MarkdownWriterContext,
  ReminderChangeContext,
} from "./markdownWriterTypes";

export const markdownWriterLog = createLogger("MarkdownWriter");

export async function notifyFileWritten(
  context: MarkdownWriterContext,
  file: Awaited<ReturnType<MarkdownWriterContext["getFile"]>>,
): Promise<void> {
  const onFileWritten = context.getOnFileWritten();
  if (onFileWritten && file) {
    await onFileWritten(file);
  }
}

export function triggerReminderChange(
  context: MarkdownWriterContext,
  reminder: Reminder,
  operation: "create" | "update" | "delete",
  changeContext?: ReminderChangeContext,
): void {
  const onReminderChange = context.getOnReminderChange();
  if (!onReminderChange) return;

  onReminderChange(reminder, operation, changeContext).catch((error) => {
    markdownWriterLog.error(`Sync failed for ${operation}`, error);
  });
}
