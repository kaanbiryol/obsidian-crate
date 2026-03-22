import * as chrono from 'chrono-node';
import type { Priority, RecurrenceRule, RecurrenceFrequency } from '../types/reminder';

export interface ParsedReminder {
  cleanContent: string;
  datePart?: string;
  priorityPart?: string;
  recurrencePart?: string;
  dueDate?: Date;
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

// Day name mappings for recurrence parsing
const DAY_NAME_MAP: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

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
    dueDate = new Date(isoDateMatch[1]);
    datePart = isoDateMatch[0]; // Keep the full match (with @ if present)
    if (taskContent.includes(isoDateMatch[0])) {
      taskContent = taskContent.replace(isoDateMatch[0], '').trim();
    }
  } else {
    // Use chrono-node to naturally find and parse dates in the content
    // Chrono handles: tomorrow, today, next Monday, in 2 hours, Jul 25 2026, etc.
    const parsed = chrono.parse(dateParseContent, new Date(), { forwardDate: true });

    if (parsed.length > 0) {
      const result = parsed[0];
      if (taskContent.includes(result.text)) {
        dueDate = result.start.date();
        datePart = result.text;
        taskContent = taskContent.replace(result.text, '').trim();
      }
    }
  }

  // Extract important marker: ! (with space before, or standalone)
  // Matches: " !" at word boundary (space before, followed by space or end)
  // Also matches: "!" as the entire content (standalone after other parts removed)
  // Does NOT match: "!" without space before when part of text (e.g., "hello!" is not important)
  const importantMatch = taskContent.match(/(?<=\s)!(?=\s|$)|^!(?=\s)|^!$/);
  if (importantMatch) {
    priority = 1;
    priorityPart = '!';
    // Remove all standalone ! markers (with space before, or standalone)
    taskContent = taskContent.replace(/(?<=\s)!(?=\s|$)|^!(?=\s)|^!$/g, '').trim();
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
    const projectMatch = contentWithoutLinks.match(/#([a-zA-Z][a-zA-Z0-9_\-\/]*)/);
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
    priority,
    project,
    recurrence,
  };
}

/**
 * Rebuild content string with new date and priority
 */
export function rebuildReminderContent(cleanContent: string, dueDate: Date | undefined, priority: Priority): string {
  let newContent = cleanContent;

  // Add date if present (without @ prefix)
  if (dueDate) {
    const year = dueDate.getFullYear();
    const month = (dueDate.getMonth() + 1).toString().padStart(2, '0');
    const day = dueDate.getDate().toString().padStart(2, '0');
    const hours = dueDate.getHours().toString().padStart(2, '0');
    const minutes = dueDate.getMinutes().toString().padStart(2, '0');

    if (dueDate.getHours() !== 0 || dueDate.getMinutes() !== 0) {
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

/**
 * Parse time string like "12:00", "2:30", "14:00" into hour and minute.
 * Returns null if not a valid time.
 */
function parseTimeString(timeStr: string): { hour: number; minute: number } | null {
  if (!timeStr) return null;

  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return { hour, minute };
}

/**
 * Parse recurrence patterns from content string.
 *
 * Supported patterns:
 * - "every day" or "daily" (optionally with time: "daily 12:00")
 * - "every week" or "weekly" (optionally with time: "weekly 14:00")
 * - "every month" or "monthly" (optionally with time: "monthly 09:00")
 * - "every Monday" or "every Mon" (specific day, optionally with time)
 * - "every Monday and Wednesday" or "every Mon, Wed, Fri" (multiple days)
 * - "every 2 weeks" or "every 3 days" (intervals, optionally with time)
 * - "monthly on 15th" or "monthly on the 1st" (specific day of month, optionally with time)
 *
 * @returns Object with matched string and parsed rule, or null if no match
 */
function parseRecurrenceFromContent(content: string): { matched: string; rule: RecurrenceRule } | null {
  // Optional time pattern: matches " HH:MM" or " H:MM" at the end
  const timePattern = '(?:\\s+(\\d{1,2}:\\d{2}))?';

  // Pattern 1: "every N days/weeks/months" (with interval, optionally with time)
  const intervalMatch = content.match(new RegExp(`\\bevery\\s+(\\d+)\\s+(day|week|month)s?${timePattern}\\b`, 'i'));
  if (intervalMatch) {
    const interval = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2].toLowerCase();
    const frequencyMap: Record<string, RecurrenceFrequency> = {
      day: 'daily',
      week: 'weekly',
      month: 'monthly',
    };
    const rule: RecurrenceRule = {
      frequency: frequencyMap[unit],
      interval: interval > 1 ? interval : undefined,
    };
    // Parse time if present
    if (intervalMatch[3]) {
      const time = parseTimeString(intervalMatch[3]);
      if (time) {
        rule.hour = time.hour;
        rule.minute = time.minute;
      }
    }
    return {
      matched: intervalMatch[0],
      rule,
    };
  }

  // Pattern 2: "every day" or "daily" (optionally with time)
  const dailyMatch = content.match(new RegExp(`\\b(?:every\\s*day|daily)${timePattern}\\b`, 'i'));
  if (dailyMatch) {
    const rule: RecurrenceRule = { frequency: 'daily' };
    // Parse time if present
    if (dailyMatch[1]) {
      const time = parseTimeString(dailyMatch[1]);
      if (time) {
        rule.hour = time.hour;
        rule.minute = time.minute;
      }
    }
    return {
      matched: dailyMatch[0],
      rule,
    };
  }

  // Pattern 3: "every week" or "weekly" (optionally with time)
  const weeklyMatch = content.match(new RegExp(`\\b(?:every\\s*week|weekly)${timePattern}\\b`, 'i'));
  if (weeklyMatch) {
    const rule: RecurrenceRule = { frequency: 'weekly' };
    // Parse time if present
    if (weeklyMatch[1]) {
      const time = parseTimeString(weeklyMatch[1]);
      if (time) {
        rule.hour = time.hour;
        rule.minute = time.minute;
      }
    }
    return {
      matched: weeklyMatch[0],
      rule,
    };
  }

  // Pattern 4: "every month" or "monthly" (optionally with day and/or time)
  const monthlyMatch = content.match(new RegExp(`\\b(?:every\\s*month|monthly)(?:\\s+on\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?)?${timePattern}\\b`, 'i'));
  if (monthlyMatch) {
    const rule: RecurrenceRule = { frequency: 'monthly' };
    if (monthlyMatch[1]) {
      const dayOfMonth = parseInt(monthlyMatch[1], 10);
      if (dayOfMonth >= 1 && dayOfMonth <= 31) {
        rule.dayOfMonth = dayOfMonth;
      }
    }
    // Parse time if present
    if (monthlyMatch[2]) {
      const time = parseTimeString(monthlyMatch[2]);
      if (time) {
        rule.hour = time.hour;
        rule.minute = time.minute;
      }
    }
    return {
      matched: monthlyMatch[0],
      rule,
    };
  }

  // Pattern 5: "every Monday" or "every Mon, Wed, Fri" (specific weekdays)
  // Also captures optional time: "every Friday 12:00"
  // Matches: "every Monday", "every Mon", "every Monday and Wednesday", "every Mon, Wed, Fri", "every Friday 12:00"
  const weekdayPattern = /\bevery\s+((?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)(?:\s*(?:,|and)\s*)?)+)(?:\s+(\d{1,2}:\d{2}))?\b/i;
  const weekdayMatch = content.match(weekdayPattern);
  if (weekdayMatch) {
    const daysText = weekdayMatch[1].toLowerCase();
    // Extract individual day names
    const dayMatches = daysText.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/gi);
    if (dayMatches && dayMatches.length > 0) {
      const daysOfWeek = [...new Set(dayMatches.map(d => DAY_NAME_MAP[d.toLowerCase()]))].sort((a, b) => a - b);
      const rule: RecurrenceRule = {
        frequency: 'weekly',
        daysOfWeek,
      };
      // Parse time if present (capture group 2)
      if (weekdayMatch[2]) {
        const time = parseTimeString(weekdayMatch[2]);
        if (time) {
          rule.hour = time.hour;
          rule.minute = time.minute;
        }
      }
      return {
        matched: weekdayMatch[0],
        rule,
      };
    }
  }

  return null;
}
