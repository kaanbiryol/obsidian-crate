import type { Priority, RecurrenceRule } from '../types/reminder';
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
  dateError?: string;
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
export function parseReminderContent(content: string, knownProjects?: string[], options: { persisted?: boolean; storedRecurrence?: boolean; preserveProjects?: boolean } = {}): ParsedReminder {
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

  const matches = findAllMatches(taskContent, knownProjects, referenceDate);
  const lastSchedule = matches.filter(match => match.type === 'date').at(-1);
  const activeSchedules = matches.filter(match => match.type === 'date' && (options.storedRecurrence || match === lastSchedule));
  const removed: Array<{ index: number; length: number }> = [];
  const recurrenceMatch = activeSchedules.filter(match => match.schedule?.kind === 'recurrence').at(-1);
  if (recurrenceMatch?.schedule?.kind === 'recurrence') {
    recurrence = recurrenceMatch.schedule.rule;
    recurrencePart = recurrenceMatch.text;
    removed.push(recurrenceMatch);
  }
  const dateMatch = activeSchedules.filter(match => match.invalid || match.schedule?.kind === 'date').at(-1);
  if (options.persisted && (dateMatch?.invalid || dateMatch?.schedule?.kind === 'date' && !dateMatch.schedule.absolute)) {
    throw new UnresolvedReminderScheduleError();
  }
  if (dateMatch?.schedule?.kind === 'date') {
    dueDate = dateMatch.schedule.dueDate;
    hasTime = dateMatch.schedule.hasTime;
    datePart = dateMatch.text;
    removed.push(dateMatch);
  }

  // Use the same protected, indexed matches as the editor. Removing text by
  // value can consume an identical token inside an earlier link or title.
  const projectMatch = matches.filter(match => match.type === 'project').at(-1);
  if (projectMatch) {
    const name = projectMatch.text.slice(1);
    project = knownProjects?.find(value => value.toLowerCase() === name.toLowerCase()) ?? name;
  }
  const priorityMatch = matches.filter(match => match.type === 'priority').at(-1);
  const markers = matches.filter(match => match === priorityMatch || !options.preserveProjects && match === projectMatch);
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
    dateError: dateMatch?.invalid ? dateMatch.error ?? `Invalid date: ${dateMatch.text}.` : undefined,
  };
}
