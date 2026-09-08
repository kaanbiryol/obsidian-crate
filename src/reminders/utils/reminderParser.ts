import * as chrono from 'chrono-node';
import type { Priority, RecurrenceRule } from '../types/reminder';
import { parseRecurrenceFromContent } from './recurrenceParser';
import { parseLocalDateKey } from './reminderDate';
import { findAllMatches } from './richTextMatchers';

export interface ParsedReminder {
  cleanContent: string;
  datePart?: string;
  priorityPart?: string;
  recurrencePart?: string;
  dueDate?: Date;
  hasTime?: boolean;
  priority: Priority;
  project?: string; // Project tag (e.g., "project1", "work")
  recurrence?: RecurrenceRule; // Parsed recurrence rule
}

export class UnresolvedReminderScheduleError extends Error {
  constructor() {
    super('Open this note in Obsidian to save its reminder schedule with an explicit date and timezone.');
  }
}

/**
 * Unified parser for reminder content that supports:
 * - ISO format dates: 2025-11-02T14:00 or 2025-11-02 (@ prefix optional)
 * - Natural language dates: tomorrow, next Monday, 22 january 12:00 (@ prefix optional)
 * - Important marker: ! (with space before, e.g., "task !" or "! task")
 * - Project tags: #projectname (e.g., #work, #project1, #MY Project)
 * - Recurrence patterns: every day, daily, every Monday, weekly, monthly, every 2 weeks
 *
 * @param content - The reminder content to parse
 * @param knownProjects - Optional list of known project names to enable matching projects with spaces
 */
export function parseReminderContent(content: string, knownProjects?: string[], options: { persisted?: boolean } = {}): ParsedReminder {
  if (!content || !content.trim()) {
    return {
      cleanContent: '',
      priority: 4,
    };
  }

  let taskContent = content;
  let dueDate: Date | undefined;
  let hasTime: boolean | undefined;
  let priority: Priority = 4;
  let datePart: string | undefined;
  let priorityPart: string | undefined;
  let recurrencePart: string | undefined;
  let project: string | undefined;
  let recurrence: RecurrenceRule | undefined;
  // Durable decoding may recognize syntax, but never infer a date from the
  // reader's clock. Draft parsing continues to resolve natural language now.
  const referenceDate = options.persisted ? new Date(2000, 0, 1, 12) : new Date();

  // IMPORTANT: Extract recurrence patterns FIRST (before date extraction)
  // This ensures "every Friday 12:00" is captured as recurrence, not just as a date
  const matches = findAllMatches(taskContent, knownProjects, referenceDate);
  const removed: Array<{ index: number; length: number }> = [];
  const recurrenceMatch = matches
    .filter(match => match.type === 'date' && parseRecurrenceFromContent(match.text)).at(-1);
  const recurrenceResult = recurrenceMatch && parseRecurrenceFromContent(recurrenceMatch.text);
  if (recurrenceResult && recurrenceMatch) {
    recurrence = recurrenceResult.rule;
    recurrencePart = recurrenceResult.matched;
    removed.push(recurrenceMatch);

    // If the recurrence matched a day+time (e.g., "every Friday 12:00"),
    // also extract the date for the first occurrence
    if (!options.persisted && !dueDate && recurrencePart) {
      const parsed = chrono.parse(recurrencePart, referenceDate, { forwardDate: true });
      const firstResult = parsed[0];
      if (firstResult) {
        dueDate = firstResult.start.date();
        hasTime = firstResult.start.isCertain('hour');
        if (!hasTime) {
          dueDate.setHours(0, 0, 0, 0);
        }
        datePart = recurrencePart; // The date is part of the recurrence pattern
      }
    }
  }

  // Try to extract ISO format date: 2025-11-02T14:00 or 2025-11-02 (@ prefix optional)
  // Also handle seconds/milliseconds + timezone suffix (e.g., 2025-11-02T14:00:00.000Z)
  // Stored reminder lines append their authoritative date after the title. Keep
  // earlier date mentions in the title when the editor saves and reloads them.
  const dateMatch = matches
    .filter(match => match.type === 'date' && !parseRecurrenceFromContent(match.text)).at(-1);
  const dateParseContent = dateMatch?.text ?? '';
  const removeDate = (offset: number, length: number) => {
    if (!dateMatch) return;
    const index = dateMatch.index + offset;
    removed.push({ index, length });
  };
  const isoDateMatch = dateParseContent.match(
    /@?(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})?)?)/
  );
  if (isoDateMatch) {
    const isoDateText = isoDateMatch[1];
    if (!isoDateText) return { cleanContent: taskContent.trim(), priority };
    hasTime = isoDateText.includes('T');
    if (options.persisted && hasTime && !/(?:Z|[+-]\d{2}:\d{2})$/.test(isoDateText)) throw new UnresolvedReminderScheduleError();
    dueDate = hasTime ? new Date(isoDateText) : parseLocalDateKey(isoDateText);
    if (isNaN(dueDate.getTime())) {
      dueDate = undefined;
      hasTime = undefined;
    } else {
      datePart = isoDateMatch[0]; // Keep the full match (with @ if present)
      removeDate(isoDateMatch.index ?? 0, isoDateMatch[0].length);
    }
  } else {
    // Use chrono-node to naturally find and parse dates in the content
    // Chrono handles: tomorrow, today, next Monday, in 2 hours, Jul 25 2026, etc.
    const parsed = chrono.parse(dateParseContent, referenceDate, { forwardDate: true });

    const result = parsed[0];
    if (result) {
      if (options.persisted && (!/\b\d{4}\b/.test(result.text)
        || !(['year', 'month', 'day'] as const).every(component => result.start.isCertain(component))
        || result.start.isCertain('hour') && !result.start.isCertain('timezoneOffset'))) throw new UnresolvedReminderScheduleError();
      if (taskContent.includes(result.text)) {
        dueDate = result.start.date();
        hasTime = result.start.isCertain('hour');
        if (!hasTime) {
          dueDate.setHours(0, 0, 0, 0);
        }
        datePart = result.text;
        removeDate(result.index, result.text.length);
      }
    }
  }

  // Use the same protected, indexed matches as the editor. Removing text by
  // value can consume an identical token inside an earlier link or title.
  const projectMatch = matches.filter(match => match.type === 'project').at(-1);
  if (projectMatch) {
    const name = projectMatch.text.slice(1);
    project = knownProjects?.find(value => value.toLowerCase() === name.toLowerCase()) ?? name;
  }
  const markers = matches.filter(match => match.type === 'priority' || match === projectMatch);
  removed.push(...markers);
  if (markers.some(match => match.type === 'priority')) {
    priority = 1;
    priorityPart = '!';
  }
  for (const match of removed.sort((a, b) => b.index - a.index)) {
    taskContent = taskContent.slice(0, match.index) + taskContent.slice(match.index + match.length);
  }

  // Clean up extra whitespace
  taskContent = taskContent.replace(/\s+/g, ' ').trim();

  return {
    cleanContent: taskContent,
    datePart,
    priorityPart,
    recurrencePart,
    dueDate,
    hasTime,
    priority,
    project,
    recurrence,
  };
}
