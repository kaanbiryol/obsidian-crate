/**
 * Checkbox Parser - Parse markdown checkbox lines for reminder syntax
 *
 * Parses markdown checkboxes like:
 * - [ ] Task content @tomorrow #project !
 * - [x] Completed task
 *
 * Used by:
 * - Obsidian plugin (inline todo enhancement)
 */

import { parseReminderContent, UnresolvedReminderScheduleError, type ParsedReminder } from './reminderParser';
import type { Priority, RecurrenceRule } from '../../types';
import { formatLocalDateKey, formatReminderDateText } from '../dates/reminderDate';
import { recurrenceToText } from '../recurrence/recurrenceText';
import { extractReminderId, setReminderIdMarker, stripReminderIdMarker } from '../reminderIdentity';
import { appendRecurrenceMetadata, readRecurrenceMetadata } from '../recurrence/recurrenceMetadata';

export interface ParsedCheckbox {
  /** Original line content */
  original: string;
  /** Leading whitespace (indentation) */
  indentation: string;
  /** Whether checkbox is checked */
  isCompleted: boolean;
  /** Content after the checkbox (before parsing) */
  rawContent: string;
  /** Stable reminder ID persisted in markdown metadata */
  reminderId: string | null;
  /** Parsed reminder data from the content */
  parsed: ParsedReminder;
}

/**
 * Regex to match markdown checkboxes
 * Groups:
 * 1. Leading whitespace (indentation)
 * 2. Checkbox state: ' ' = uncompleted, 'x'/'X' = completed
 * 3. Content after checkbox
 */
const CHECKBOX_REGEX = /^(\s*)-\s*\[([ xX])\]\s*(.*)$/;

/** Checkbox completion without parsing reminder content; null for non-checkbox lines. */
export function readCheckboxCompletion(line: string): boolean | null {
  const state = (line.endsWith('\r') ? line.slice(0, -1) : line).match(CHECKBOX_REGEX)?.[2];
  return state === undefined ? null : state.toLowerCase() === 'x';
}

/**
 * Parse a markdown checkbox line
 *
 * @param line - Single line of markdown text
 * @returns ParsedCheckbox if line contains a checkbox, null otherwise
 */
export function parseCheckboxLine(line: string, options: { persisted?: boolean } = {}): ParsedCheckbox | null {
  return options.persisted ? parsePersistedCheckboxLine(line) : readCheckboxLine(line, options);
}

const PERSISTED_PARSE_GENERATION = 2048;
const UNRESOLVED = Symbol('unresolved');
type PersistedParse = ParsedCheckbox | null | typeof UNRESOLVED;
// Two generations bound memory without per-hit reordering: a full current
// generation becomes the previous one, and hits there move back to current.
let currentParses = new Map<string, PersistedParse>();
let previousParses = new Map<string, PersistedParse>();
let persistedParseZone: string | undefined;

/** Local offsets that persisted dates depend on, without Intl's per-call cost. */
function localZoneKey(): string {
  const year = new Date().getFullYear();
  return [2000, year].map(value => `${new Date(value, 0, 1, 12).getTimezoneOffset()},${new Date(value, 6, 1, 12).getTimezoneOffset()}`).join(';');
}

function cloneParsedCheckbox(checkbox: ParsedCheckbox): ParsedCheckbox {
  const { dueDate, recurrence } = checkbox.parsed;
  return {
    ...checkbox,
    parsed: {
      ...checkbox.parsed,
      ...(dueDate ? { dueDate: new Date(dueDate.getTime()) } : {}),
      ...(recurrence ? { recurrence: { ...recurrence, ...(recurrence.daysOfWeek ? { daysOfWeek: [...recurrence.daysOfWeek] } : {}) } } : {}),
    },
  };
}

/**
 * Persisted parsing uses a fixed reference date, so a line's result depends
 * only on its text and the local timezone. Rescans reuse unchanged lines from
 * a bounded cache; callers receive clones because results are mutable.
 */
function parsePersistedCheckboxLine(line: string): ParsedCheckbox | null {
  const zone = localZoneKey();
  if (zone !== persistedParseZone) {
    currentParses = new Map();
    previousParses = new Map();
    persistedParseZone = zone;
  }
  let cached = currentParses.get(line);
  if (cached === undefined && !currentParses.has(line)) {
    cached = previousParses.get(line);
    if (cached === undefined && !previousParses.has(line)) {
      try {
        cached = readCheckboxLine(line, { persisted: true });
      } catch (error) {
        if (!(error instanceof UnresolvedReminderScheduleError)) throw error;
        cached = UNRESOLVED;
      }
    }
    if (currentParses.size >= PERSISTED_PARSE_GENERATION) {
      previousParses = currentParses;
      currentParses = new Map();
    }
    currentParses.set(line, cached as PersistedParse);
  }
  if (cached === UNRESOLVED) throw new UnresolvedReminderScheduleError();
  return cached ? cloneParsedCheckbox(cached) : null;
}

function readCheckboxLine(line: string, options: { persisted?: boolean }): ParsedCheckbox | null {
  const match = (line.endsWith('\r') ? line.slice(0, -1) : line).match(CHECKBOX_REGEX);
  if (!match) {
    return null;
  }

  const [, indentation, state, rawContentWithMetadata] = match;
  if (indentation === undefined || state === undefined || rawContentWithMetadata === undefined) {
    return null;
  }
  const isCompleted = state.toLowerCase() === 'x';
  const reminderId = extractReminderId(rawContentWithMetadata);
  const metadata = readRecurrenceMetadata(stripReminderIdMarker(rawContentWithMetadata), options);
  const rawContent = metadata.content;
  // Stored recurrence metadata distinguishes an explicit repeat rule plus its
  // next occurrence from earlier repeat words retained as literal title text.
  const parsed = parseReminderContent(rawContent, undefined, {
    ...options, storedRecurrence: /<!-- crate-rule:/.test(rawContentWithMetadata), preserveProjects: true,
  });
  const matchingRecurrence = metadata.recurrence && parsed.recurrencePart?.toLowerCase() === recurrenceToText(metadata.recurrence).toLowerCase();
  if (matchingRecurrence) parsed.recurrence = metadata.recurrence;
  if (options.persisted && parsed.recurrence && (!matchingRecurrence || !parsed.dueDate)) throw new UnresolvedReminderScheduleError();

  return {
    original: line,
    indentation,
    isCompleted,
    rawContent,
    reminderId,
    parsed,
  };
}

/**
 * Share the persisted parse of a line between schedule normalization and the
 * scan that follows it. Each remembered result is handed out once, so identical
 * lines never share parsed objects; failures are not remembered.
 */
export function createPersistedCheckboxParses() {
  const remembered = new Map<string, ParsedCheckbox | null>();
  return {
    remember: (line: string): ParsedCheckbox | null => {
      const parsed = parseCheckboxLine(line, { persisted: true });
      remembered.set(line, parsed);
      return parsed;
    },
    take: (line: string): ParsedCheckbox | null => {
      if (!remembered.has(line)) return parseCheckboxLine(line, { persisted: true });
      const parsed = remembered.get(line)!;
      remembered.delete(line);
      return parsed;
    },
  };
}

export interface CheckboxLineOptions {
  /** Leading whitespace. */
  indentation?: string;
  completed: boolean;
  /** Task text without date or priority markers. */
  content: string;
  /** Shown even with recurrence, as the next occurrence. */
  dueDate?: Date;
  /** 1 marks the reminder important; 4 is normal. */
  priority: Priority;
  /** Written before the date, the order it is parsed in. */
  recurrence?: RecurrenceRule;
  hasTime?: boolean;
  reminderId?: string;
  /** Write a date-only due as `2026-10-30` instead of `Oct 30, 2026`. */
  isoDate?: boolean;
}

/** Rebuilds a checkbox line with updated data. */
export function rebuildCheckboxLine({
  indentation = '', completed: isCompleted, content: cleanContent, dueDate, priority, recurrence, hasTime, reminderId, isoDate = false,
}: CheckboxLineOptions): string {
  const checkbox = isCompleted ? '[x]' : '[ ]';

  // Build content with correct order: recurrence, date, priority
  let content = cleanContent;

  // Add recurrence text FIRST (before date) - matches parse order
  if (recurrence) {
    content += ` ${recurrenceToText(recurrence)}`;
  }

  // Add date if present (even with recurrence, to show next occurrence)
  if (dueDate) {
    const showTime = hasTime ?? (recurrence?.hour !== undefined || dueDate.getHours() !== 0 || dueDate.getMinutes() !== 0);
    const formatted = showTime
      ? dueDate.toISOString()
      : isoDate ? formatLocalDateKey(dueDate) : formatReminderDateText(dueDate);        // "Jan 13, 2026"
    content += ` ${formatted}`;
  }

  // Note: Project tag intentionally not added - project is determined by file location

  // Add important marker if priority is 1
  if (priority === 1) {
    content += ' !';
  }

  const line = appendRecurrenceMetadata(`${indentation}- ${checkbox} ${content}`, recurrence);
  return reminderId ? setReminderIdMarker(line, reminderId) : line;
}
