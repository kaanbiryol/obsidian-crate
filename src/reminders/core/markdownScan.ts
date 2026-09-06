import { parseCheckboxLine, generateContentHash } from "@/reminders/utils/checkboxParser";
import { buildStoredReminderDates } from "@/reminders/utils/reminderDate";
import { normalizeRecurrenceRule } from "@/reminders/utils/recurrenceRule";
import type { Priority, RecurrenceRule } from "@/reminders/types/reminder";
import { decodeDescriptionFromMarkdown } from "./markdownReminderFile";

interface ScannedReminderRecord {
  id: string;
  content: string;
  description?: string;
  dueDate?: string;
  dueDatetime?: string;
  priority: Priority;
  completed: boolean;
  project: string;
  recurrence?: RecurrenceRule;
  filePath: string;
  lineNumber: number;
  rawLine: string;
  contentHash: string;
}

export interface ReminderMarkdownScanResult {
  reminders: ScannedReminderRecord[];
  lineCount: number;
}

export function getProjectFromPath(filePath: string, remindersFolderPath: string): string {
  const normalizedFolder = remindersFolderPath.replace(/^\/|\/$/g, '');

  let relativePath = filePath;
  if (filePath.startsWith(normalizedFolder + "/")) {
    relativePath = filePath.slice(normalizedFolder.length + 1);
  }

  if (relativePath.toLowerCase().endsWith(".md")) {
    relativePath = relativePath.slice(0, -3);
  }

  return relativePath || "Inbox";
}

export function scanReminderMarkdownContent(
  filePath: string,
  content: string,
  remindersFolderPath: string,
): ReminderMarkdownScanResult {
  const reminders: ScannedReminderRecord[] = [];
  const project = getProjectFromPath(filePath, remindersFolderPath);
  const lines = content.split("\n");

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
    const line = lines[lineNumber];
    if (line === undefined) continue;
    const parsed = parseCheckboxLine(line);
    if (!parsed || !parsed.parsed.cleanContent.trim() || !parsed.reminderId) {
      continue;
    }

    const storedDates = buildStoredReminderDates(parsed.parsed.dueDate, parsed.parsed.hasTime);
    let description: string | undefined;
    let descBlockLineCount = 0;
    const nextIndex = lineNumber + 1;
    const nextLine = lines[nextIndex];
    if (nextLine?.startsWith("<!-- crate-desc:")) {
      if (!nextLine.endsWith(' -->')) throw new Error('Invalid reminder description block');
      description = decodeDescriptionFromMarkdown(nextLine.slice('<!-- crate-desc:'.length, -4)) || undefined;
      descBlockLineCount = 1;
    }

    reminders.push({
      id: parsed.reminderId,
      content: parsed.parsed.cleanContent,
      description,
      dueDate: storedDates.dueDate,
      dueDatetime: storedDates.dueDatetime,
      priority: parsed.parsed.priority,
      completed: parsed.isCompleted,
      project,
      recurrence: normalizeRecurrenceRule(parsed.parsed.recurrence),
      filePath,
      lineNumber,
      rawLine: line,
      contentHash: generateContentHash(parsed.rawContent),
    });

    if (descBlockLineCount > 0) {
      lineNumber = nextIndex + descBlockLineCount - 1;
    }
  }

  return {
    reminders,
    lineCount: lines.length,
  };
}
