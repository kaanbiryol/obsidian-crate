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
  const normalizedFile = filePath.toLowerCase();
  const normalizedFolder = remindersFolderPath.replace(/^\/|\/$/g, '').toLowerCase();

  let relativePath = filePath;
  if (normalizedFile.startsWith(normalizedFolder + "/")) {
    relativePath = filePath.slice(remindersFolderPath.length + 1);
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
    const parsed = parseCheckboxLine(line);
    if (!parsed || !parsed.parsed.cleanContent.trim() || !parsed.reminderId) {
      continue;
    }

    const storedDates = buildStoredReminderDates(parsed.parsed.dueDate, parsed.parsed.hasTime);
    let description: string | undefined;
    let descBlockLineCount = 0;
    const nextIndex = lineNumber + 1;
    if (nextIndex < lines.length && lines[nextIndex].startsWith("<!-- crate-desc:")) {
      let descContent = lines[nextIndex].slice("<!-- crate-desc:".length);
      let endIndex = nextIndex;
      while (endIndex < lines.length) {
        const source = endIndex === nextIndex ? descContent : lines[endIndex];
        const closingPos = source.indexOf("-->");
        if (closingPos !== -1) {
          if (endIndex === nextIndex) {
            descContent = descContent.slice(0, closingPos).trimEnd();
          } else {
            descContent += "\n" + lines[endIndex].slice(0, closingPos).trimEnd();
          }
          descBlockLineCount = endIndex - nextIndex + 1;
          break;
        }
        if (endIndex > nextIndex) {
          descContent += "\n" + lines[endIndex];
        }
        endIndex++;
      }
      description = decodeDescriptionFromMarkdown(descContent) || undefined;
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
