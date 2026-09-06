import { createLogger } from "@/reminders/utils/logger";
import type {
  MarkdownWriterContext,
} from "./types";

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
