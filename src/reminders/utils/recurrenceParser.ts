import type { RecurrenceFrequency, RecurrenceRule } from '../types/reminder';
import { normalizeRecurrenceRule } from './recurrenceRule';

const DAY_NAME_MAP: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

function parseTimeString(timeStr: string): { hour: number; minute: number } | null {
  if (!timeStr) return null;

  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);

  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  return { hour, minute };
}

function applyTime(rule: RecurrenceRule, timeText: string | undefined): void {
  if (!timeText) return;

  const time = parseTimeString(timeText);
  if (!time) return;

  rule.hour = time.hour;
  rule.minute = time.minute;
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
export function parseRecurrenceFromContent(content: string): { matched: string; rule: RecurrenceRule } | null {
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
    const rule = normalizeRecurrenceRule({
      frequency: frequencyMap[unit],
      interval: interval > 1 ? interval : undefined,
    })!;
    applyTime(rule, intervalMatch[3]);
    return {
      matched: intervalMatch[0],
      rule,
    };
  }

  // Pattern 2: "every day" or "daily" (optionally with time)
  const dailyMatch = content.match(new RegExp(`\\b(?:every\\s*day|daily)${timePattern}\\b`, 'i'));
  if (dailyMatch) {
    const rule = normalizeRecurrenceRule({ frequency: 'daily' })!;
    applyTime(rule, dailyMatch[1]);
    return {
      matched: dailyMatch[0],
      rule,
    };
  }

  // Pattern 3: "every week" or "weekly" (optionally with time)
  const weeklyMatch = content.match(new RegExp(`\\b(?:every\\s*week|weekly)${timePattern}\\b`, 'i'));
  if (weeklyMatch) {
    const rule = normalizeRecurrenceRule({ frequency: 'weekly' })!;
    applyTime(rule, weeklyMatch[1]);
    return {
      matched: weeklyMatch[0],
      rule,
    };
  }

  // Pattern 4: "every month" or "monthly" (optionally with day and/or time)
  const monthlyMatch = content.match(new RegExp(`\\b(?:every\\s*month|monthly)(?:\\s+on\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?)?${timePattern}\\b`, 'i'));
  if (monthlyMatch) {
    const rule = normalizeRecurrenceRule({ frequency: 'monthly' })!;
    if (monthlyMatch[1]) {
      const dayOfMonth = parseInt(monthlyMatch[1], 10);
      if (dayOfMonth >= 1 && dayOfMonth <= 31) {
        rule.dayOfMonth = dayOfMonth;
      }
    }
    applyTime(rule, monthlyMatch[2]);
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
    const dayMatches = daysText.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/gi);
    if (dayMatches && dayMatches.length > 0) {
      const daysOfWeek = [...new Set(dayMatches.map(d => DAY_NAME_MAP[d.toLowerCase()]))].sort((a, b) => a - b);
      const rule = normalizeRecurrenceRule({
        frequency: 'weekly',
        daysOfWeek,
      })!;
      applyTime(rule, weekdayMatch[2]);
      return {
        matched: weekdayMatch[0],
        rule,
      };
    }
  }

  return null;
}
