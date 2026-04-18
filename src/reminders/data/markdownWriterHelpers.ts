import type { App, TFile } from "obsidian";
import {
  createLogger,
  type RecurrenceRule,
  type Reminder,
} from "@/reminders";
import { parseCheckboxLine } from "@/reminders/utils/checkboxParser";
import { buildStoredReminderDates } from "@/reminders/utils/reminderDate";
import { normalizeRecurrenceRule } from "@/reminders/utils/recurrenceRule";
import { extractReminderId } from "./reminderIdentity";
import type { IndexedReminder, ReminderIndex } from "./reminderIndex";

const log = createLogger("MarkdownWriter");

function recurrenceKey(value: RecurrenceRule | undefined): string {
  return JSON.stringify(normalizeRecurrenceRule(value) ?? null);
}

function lineMatchesReminder(line: string, reminder: IndexedReminder): boolean {
  const parsed = parseCheckboxLine(line);
  if (!parsed) {
    return false;
  }

  const storedDates = buildStoredReminderDates(parsed.parsed.dueDate, parsed.parsed.hasTime);
  return parsed.parsed.cleanContent === reminder.content
    && parsed.isCompleted === reminder.completed
    && parsed.parsed.priority === reminder.priority
    && storedDates.dueDate === reminder.dueDate
    && storedDates.dueDatetime === reminder.dueDatetime
    && recurrenceKey(parsed.parsed.recurrence) === recurrenceKey(reminder.recurrence);
}

export function findReminderLineNumber(lines: string[], reminder: IndexedReminder): number {
  if (
    reminder.lineNumber >= 0
    && reminder.lineNumber < lines.length
    && lines[reminder.lineNumber] === reminder.rawLine
  ) {
    return reminder.lineNumber;
  }

  for (let index = 0; index < lines.length; index++) {
    if (extractReminderId(lines[index]) === reminder.id) {
      return index;
    }
  }

  const exactMatches: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lines[index] === reminder.rawLine) {
      exactMatches.push(index);
    }
  }
  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  const semanticMatches: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (lineMatchesReminder(lines[index], reminder)) {
      semanticMatches.push(index);
    }
  }
  if (semanticMatches.length === 1) {
    return semanticMatches[0];
  }

  return -1;
}

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
    const projectName = project.split("/").pop() || project;
    const initialContent = `# ${projectName}\n\n`;
    await app.vault.create(filePath, initialContent);
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

export function buildDescriptionBlock(description: string | undefined): string[] {
  if (!description?.trim()) return [];
  return [`<!-- crate-desc:${description.trim()} -->`];
}

export function countDescriptionBlockLines(
  lines: string[],
  checkboxLineNumber: number,
): number {
  const nextIndex = checkboxLineNumber + 1;
  if (nextIndex >= lines.length || !lines[nextIndex].startsWith("<!-- crate-desc:")) return 0;

  for (let index = nextIndex; index < lines.length; index++) {
    if (lines[index].includes("-->")) return index - nextIndex + 1;
  }

  return 0;
}
