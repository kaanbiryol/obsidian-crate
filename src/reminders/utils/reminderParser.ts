import * as chrono from 'chrono-node';
import type { Priority, RecurrenceRule } from '../types/reminder';
import {
  findStandalonePriorityMarkerIndexes,
  removeStandalonePriorityMarkers,
} from './priorityMarker';
import { parseRecurrenceFromContent } from './recurrenceParser';
import { parseLocalDateKey } from './reminderDate';

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

function stripUrlsForDateParsing(content: string): string {
  // Keep link text, but drop URLs so chrono doesn't parse dates from them.
  let sanitized = content.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Remove markdown autolinks like <https://...>
  sanitized = sanitized.replace(/<https?:\/\/[^>\s]+>/gi, ' ');
  // Remove bare URLs
  sanitized = sanitized.replace(/\bhttps?:\/\/[^\s)]+/gi, ' ');
  return sanitized;
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
export function parseReminderContent(content: string, knownProjects?: string[]): ParsedReminder {
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

  // IMPORTANT: Extract recurrence patterns FIRST (before date extraction)
  // This ensures "every Friday 12:00" is captured as recurrence, not just as a date
  const recurrenceResult = parseRecurrenceFromContent(taskContent);
  if (recurrenceResult) {
    recurrence = recurrenceResult.rule;
    recurrencePart = recurrenceResult.matched;
    taskContent = taskContent.replace(recurrenceResult.matched, '').trim();

    // If the recurrence matched a day+time (e.g., "every Friday 12:00"),
    // also extract the date for the first occurrence
    if (!dueDate && recurrencePart) {
      const parsed = chrono.parse(recurrencePart, new Date(), { forwardDate: true });
      if (parsed.length > 0) {
        dueDate = parsed[0].start.date();
        hasTime = parsed[0].start.isCertain('hour');
        if (!hasTime) {
          dueDate.setHours(0, 0, 0, 0);
        }
        datePart = recurrencePart; // The date is part of the recurrence pattern
      }
    }
  }

  // Try to extract ISO format date: 2025-11-02T14:00 or 2025-11-02 (@ prefix optional)
  // Also handle seconds/milliseconds + timezone suffix (e.g., 2025-11-02T14:00:00.000Z)
  const dateParseContent = stripUrlsForDateParsing(taskContent);
  const isoDateMatch = dateParseContent.match(
    /@?(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})?)?)/
  );
  if (isoDateMatch) {
    hasTime = isoDateMatch[1].includes('T');
    dueDate = hasTime ? new Date(isoDateMatch[1]) : parseLocalDateKey(isoDateMatch[1]);
    if (isNaN(dueDate.getTime())) {
      dueDate = undefined;
      hasTime = undefined;
    } else {
      datePart = isoDateMatch[0]; // Keep the full match (with @ if present)
      if (taskContent.includes(isoDateMatch[0])) {
        taskContent = taskContent.replace(isoDateMatch[0], '').trim();
      }
    }
  } else {
    // Use chrono-node to naturally find and parse dates in the content
    // Chrono handles: tomorrow, today, next Monday, in 2 hours, Jul 25 2026, etc.
    const parsed = chrono.parse(dateParseContent, new Date(), { forwardDate: true });

    if (parsed.length > 0) {
      const result = parsed[0];
      if (taskContent.includes(result.text)) {
        dueDate = result.start.date();
        hasTime = result.start.isCertain('hour');
        if (!hasTime) {
          dueDate.setHours(0, 0, 0, 0);
        }
        datePart = result.text;
        taskContent = taskContent.replace(result.text, '').trim();
      }
    }
  }

  // Extract important marker: ! (with space before, or standalone)
  // Matches: " !" at word boundary (space before, followed by space or end)
  // Also matches: "!" as the entire content (standalone after other parts removed)
  // Does NOT match: "!" without space before when part of text (e.g., "hello!" is not important)
  const priorityMarkerIndexes = findStandalonePriorityMarkerIndexes(taskContent);
  if (priorityMarkerIndexes.length > 0) {
    priority = 1;
    priorityPart = '!';
    taskContent = removeStandalonePriorityMarkers(taskContent).trim();
  }

  // Extract project tag: #projectname (single word/identifier)
  // - Must start with a letter (not purely numeric like #338)
  // - Can contain letters, numbers, underscores, hyphens
  // - Skip tags inside markdown links [text](url)
  // - If knownProjects provided, try matching multi-word projects first

  // First, temporarily remove markdown links to avoid matching inside them
  const linkPlaceholders: string[] = [];
  const contentWithoutLinks = taskContent.replace(/\[([^\]]*)\]\([^)]*\)/g, (match) => {
    linkPlaceholders.push(match);
    return `\x00LINK${linkPlaceholders.length - 1}\x00`;
  });

  // Try to match against known projects first (supports multi-word projects like "MY Project")
  // Sort by length descending to match longest first (e.g., "Work Project" before "Work")
  if (knownProjects && knownProjects.length > 0) {
    const sortedProjects = [...knownProjects].sort((a, b) => b.length - a.length);
    for (const knownProject of sortedProjects) {
      // Escape special regex characters in the project name
      const escapedProject = knownProject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Case-insensitive match with word boundary lookahead (space, end, or next marker)
      const projectRegex = new RegExp(`#${escapedProject}(?=\\s|$|@|!|#)`, 'i');
      const knownProjectMatch = contentWithoutLinks.match(projectRegex);
      if (knownProjectMatch) {
        // Return original casing from knownProjects
        project = knownProject;
        // Remove from the content (use the actual matched text to preserve original content)
        taskContent = taskContent.replace(projectRegex, '').trim();
        break;
      }
    }
  }

  // Fallback: Support nested tags with / (e.g., #Project/Reminders, #work/meetings)
  // Only if no project was matched from knownProjects
  if (!project) {
    const projectMatch = contentWithoutLinks.match(/#([a-zA-Z][a-zA-Z0-9_/-]*)/);
    if (projectMatch) {
      project = projectMatch[1].trim();
      // Remove from the content with links intact
      // Escape special regex characters in the project name (particularly / for nested tags)
      const escapedProject = project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      taskContent = taskContent.replace(new RegExp('#' + escapedProject + '(?:\\b|$)'), '').trim();
    }
  }

  // Note: Recurrence patterns are now extracted FIRST at the top of this function
  // This ensures "every Friday 12:00" is captured as recurrence before date parsing

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

/**
 * Rebuild content string with new date and priority
 */
export function rebuildReminderContent(cleanContent: string, dueDate: Date | undefined, priority: Priority, hasTime?: boolean): string {
  let newContent = cleanContent;

  // Add date if present (without @ prefix)
  if (dueDate) {
    const year = dueDate.getFullYear();
    const month = (dueDate.getMonth() + 1).toString().padStart(2, '0');
    const day = dueDate.getDate().toString().padStart(2, '0');

    if (hasTime) {
      const hours = dueDate.getHours().toString().padStart(2, '0');
      const minutes = dueDate.getMinutes().toString().padStart(2, '0');
      newContent += ` ${year}-${month}-${day}T${hours}:${minutes}`;
    } else {
      newContent += ` ${year}-${month}-${day}`;
    }
  }

  // Add important marker if priority is 1
  if (priority === 1) {
    newContent += ' !';
  }

  return newContent;
}
