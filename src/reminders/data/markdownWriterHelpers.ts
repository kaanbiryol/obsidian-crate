import type { App, TFile } from "obsidian";
import type { Reminder } from "@/reminders/types/reminder";
import { createLogger } from "@/reminders/utils/logger";
import { normalizeRecurrenceRule } from "@/reminders/utils/recurrenceRule";
import type { IndexedReminder, ReminderIndex } from "./reminderIndex";
import { getInitialProjectFileContent } from "./markdownReminderFile";
export {
  buildDescriptionBlock,
  countDescriptionBlockLines,
  findReminderLineNumber,
} from "./markdownReminderFile";

const log = createLogger("MarkdownWriter");

function isTFileLike(value: unknown): value is TFile {
  return typeof value === "object"
    && value !== null
    && "path" in value
    && typeof value.path === "string"
    && "extension" in value
    && typeof value.extension === "string";
}

export async function getFile(app: App, filePath: string): Promise<TFile | null> {
  const abstractFile = app.vault.getAbstractFileByPath(filePath);
  if (isTFileLike(abstractFile)) {
    return abstractFile;
  }
  return null;
}

export async function getOrCreateProjectFile(
  app: App,
  index: ReminderIndex,
  project: string,
): Promise<TFile> {
  const folderPath = index.remindersFolderPath;
  const filePath = `${folderPath}/${project}.md`;

  const folderExists = await app.vault.adapter.exists(folderPath);
  if (!folderExists) {
    await app.vault.createFolder(folderPath);
    log.info(` Created folder: ${folderPath}`);
  }

  let file = await getFile(app, filePath);
  if (!file) {
    await app.vault.create(filePath, getInitialProjectFileContent(project));
    file = await getFile(app, filePath);
    log.info(` Created project file: ${filePath}`);
  }

  if (!file) {
    throw new Error(`Failed to create project file: ${filePath}`);
  }

  return file;
}

export function toReminder(indexed: IndexedReminder): Reminder {
  return {
    id: indexed.id,
    content: indexed.content,
    description: indexed.description,
    dueDate: indexed.dueDate,
    dueDatetime: indexed.dueDatetime,
    priority: indexed.priority,
    completed: indexed.completed,
    project: indexed.project || "Inbox",
    recurrence: normalizeRecurrenceRule(indexed.recurrence),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
