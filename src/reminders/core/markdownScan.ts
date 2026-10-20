import { parseCheckboxLine, type ParsedCheckbox } from "@/reminders/core/grammar/checkboxParser";
import { buildStoredReminderDates } from "@/reminders/core/dates/reminderDate";
import { normalizeRecurrenceRule } from "@/reminders/core/recurrence/recurrenceRule";
import type { Priority, RecurrenceRule } from "@/reminders/types/reminder";
import { readDescriptionBlock } from "./reminderDescription";
import { UnresolvedReminderScheduleError } from './grammar/reminderParser';
import { extractReminderId } from './reminderIdentity';
import { markdownTaskContexts } from './markdownTaskContext';
import { DEFAULT_PROJECT } from "./constants";

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

  return relativePath || DEFAULT_PROJECT;
}

export function scanReminderMarkdownContent(
  filePath: string,
  content: string,
  remindersFolderPath: string,
  options: { skipUnresolvedSchedules?: boolean; parsePersisted?: (line: string) => ParsedCheckbox | null } = {},
): ReminderMarkdownScanResult {
  const reminders: ScannedReminderRecord[] = [];
  const project = getProjectFromPath(filePath, remindersFolderPath);
  const lines = content.split("\n");

  for (const lineNumber of markdownTaskContexts(lines).keys()) {
    const line = lines[lineNumber];
    if (line === undefined || !extractReminderId(line)) continue;
    let parsed;
    try { parsed = options.parsePersisted ? options.parsePersisted(line) : parseCheckboxLine(line, { persisted: true }); }
    catch (error) {
      if (options.skipUnresolvedSchedules && error instanceof UnresolvedReminderScheduleError) continue;
      throw error;
    }
    if (!parsed || !parsed.parsed.cleanContent.trim() || !parsed.reminderId) {
      continue;
    }

    const storedDates = buildStoredReminderDates(parsed.parsed.dueDate, parsed.parsed.hasTime);
    const { description } = readDescriptionBlock(lines, lineNumber);

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
    });

  }

  return {
    reminders,
    lineCount: lines.length,
  };
}
