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

import { parseReminderContent, type ParsedReminder } from './reminderParser';
import type { Priority, RecurrenceRule } from '../types';
import { format } from 'date-fns';
import { recurrenceToText } from './rruleConverter';
import { extractReminderId, setReminderIdMarker, stripReminderIdMarker } from '../core/reminderIdentity';

interface ParsedCheckbox {
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

/**
 * Parse a markdown checkbox line
 *
 * @param line - Single line of markdown text
 * @returns ParsedCheckbox if line contains a checkbox, null otherwise
 */
export function parseCheckboxLine(line: string): ParsedCheckbox | null {
  const match = line.match(CHECKBOX_REGEX);
  if (!match) {
    return null;
  }

  const [, indentation, state, rawContentWithMetadata] = match;
  const isCompleted = state.toLowerCase() === 'x';
  const reminderId = extractReminderId(rawContentWithMetadata);
  const rawContent = stripReminderIdMarker(rawContentWithMetadata);
  const parsed = parseReminderContent(rawContent);

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
 * Rebuild a checkbox line with updated data
 *
 * @param indentation - Leading whitespace
 * @param isCompleted - Whether checkbox should be checked
 * @param cleanContent - Task content (without date/priority markers)
 * @param dueDate - Optional due date
 * @param priority - Priority level (1 = important, 4 = normal)
 * @param project - Optional project tag (not written; project is determined by file location)
 * @param recurrence - Optional recurrence rule (added before date)
 * @returns Formatted markdown checkbox line
 */
export function rebuildCheckboxLine(
  indentation: string,
  isCompleted: boolean,
  cleanContent: string,
  dueDate: Date | undefined,
  priority: Priority,
  project?: string,
  recurrence?: RecurrenceRule,
  hasTime?: boolean,
  reminderId?: string,
): string {
  const checkbox = isCompleted ? '[x]' : '[ ]';

  // Build content with correct order: recurrence, date, priority
  let content = cleanContent;

  // Add recurrence text FIRST (before date) - matches parse order
  if (recurrence) {
    content += ` ${recurrenceToText(recurrence)}`;
  }

  // Add date if present (even with recurrence, to show next occurrence)
  if (dueDate) {
    // When recurrence has time, only show date (avoid duplicating time)
    const recurrenceHasTime = recurrence?.hour !== undefined;
    const showTime = !recurrenceHasTime && (hasTime ?? (dueDate.getHours() !== 0 || dueDate.getMinutes() !== 0));
    const formatted = showTime
      ? format(dueDate, "MMM d, yyyy HH:mm")   // "Jan 13, 2026 12:00"
      : format(dueDate, "MMM d, yyyy");        // "Jan 13, 2026"
    content += ` ${formatted}`;
  }

  // Note: Project tag intentionally not added - project is determined by file location

  // Add important marker if priority is 1
  if (priority === 1) {
    content += ' !';
  }

  const line = `${indentation}- ${checkbox} ${content}`;
  return reminderId ? setReminderIdMarker(line, reminderId) : line;
}

/**
 * Get project name from file path
 * Extracts filename without extension
 *
 * @param filePath - Full file path (e.g., "folder/My Notes.md")
 * @returns Project name (e.g., "My Notes")
 */
/**
 * Generate a deterministic content hash for tracking line identity
 * Used to detect when lines are moved vs edited
 */
export function generateContentHash(content: string): string {
  const withoutMetadata = stripReminderIdMarker(content);
  const parsedCheckbox = parseCheckboxLine(withoutMetadata);
  const hashSource = parsedCheckbox ? parsedCheckbox.rawContent : withoutMetadata;
  // Simple hash based on cleaned content (ignoring dates/priority which change)
  const cleaned = parseReminderContent(hashSource).cleanContent.toLowerCase().trim();
  let hash = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}
