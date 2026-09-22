import type { RecurrenceRule } from '../types/reminder';
import { timezone as getLocalTimeZone } from './time';
import { canonicalReminderTimezone } from './reminderTimezone';
import { formatReminderTime } from './reminderDate';

/** Show a non-local rule's zone when editing; durable Markdown keeps its existing format. */
export function recurrenceToEditorText(rule: RecurrenceRule): string {
  // Stored IANA aliases (e.g. CET) may have a different meaning from Chrono's
  // typed abbreviations. Display their canonical name to preserve the rule.
  const timezone = rule.timezone && canonicalReminderTimezone(rule.timezone);
  const zone = timezone && timezone !== canonicalReminderTimezone(getLocalTimeZone()) ? ` ${timezone}` : '';
  return recurrenceToText(rule) + zone;
}

/**
 * Get a human-readable description of a recurrence rule.
 *
 * Examples:
 * - { frequency: 'daily' } => "Daily"
 * - { frequency: 'daily', hour: 20, minute: 0 } => "Daily at 8:00 PM"
 * - { frequency: 'weekly', daysOfWeek: [1, 3, 5] } => "Weekly on Mon, Wed, Fri"
 * - { frequency: 'weekly', daysOfWeek: [2], hour: 20, minute: 0 } => "Weekly on Tue at 8:00 PM"
 * - { frequency: 'monthly', dayOfMonth: 15 } => "Monthly on the 15th"
 * - { frequency: 'monthly', dayOfMonth: 20, hour: 20, minute: 0 } => "Monthly on the 20th at 8:00 PM"
 * - { frequency: 'weekly', interval: 2 } => "Every 2 weeks"
 */
export function formatRecurrence(rule: RecurrenceRule): string {
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const interval = rule.interval || 1;
  const { hour, minute } = rule;
  const timeStr = hour !== undefined && minute !== undefined
    ? ` at ${formatReminderTime(hour, minute, rule.second, rule.millisecond)}`
    : '';

  if (rule.frequency === 'daily') {
    if (interval === 1) {
      return `Daily${timeStr}`;
    }
    return `Every ${interval} days${timeStr}`;
  }

  if (rule.frequency === 'weekly') {
    let base = interval === 1 ? 'Weekly' : `Every ${interval} weeks`;
    if (rule.daysOfWeek && rule.daysOfWeek.length > 0) {
      const days = rule.daysOfWeek.map(d => DAY_NAMES[d]).join(', ');
      base += ` on ${days}`;
    }
    return base + timeStr;
  }

  if (rule.frequency === 'monthly') {
    let base = interval === 1 ? 'Monthly' : `Every ${interval} months`;
    if (rule.dayOfMonth) {
      const suffix = getOrdinalSuffix(rule.dayOfMonth);
      base += ` on the ${rule.dayOfMonth}${suffix}`;
    }
    return base + timeStr;
  }

  return 'Repeating';
}

function getOrdinalSuffix(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
	return s[(v - 20) % 10] || s[v] || 'th';
}

/**
 * Convert a RecurrenceRule to natural language text that can be parsed by the NLP parser.
 * This is different from formatRecurrence() which is for display purposes.
 *
 * Examples:
 * - { frequency: 'daily' } => "daily"
 * - { frequency: 'daily', hour: 20, minute: 0 } => "daily 20:00"
 * - { frequency: 'daily', interval: 2 } => "every 2 days"
 * - { frequency: 'weekly' } => "weekly"
 * - { frequency: 'weekly', interval: 2 } => "every 2 weeks"
 * - { frequency: 'weekly', daysOfWeek: [1, 3, 5] } => "every Mon, Wed, Fri"
 * - { frequency: 'weekly', daysOfWeek: [2], hour: 20, minute: 0 } => "every Tue 20:00"
 * - { frequency: 'monthly' } => "monthly"
 * - { frequency: 'monthly', dayOfMonth: 15 } => "monthly on the 15th"
 * - { frequency: 'monthly', dayOfMonth: 20, hour: 20, minute: 0 } => "monthly on the 20th 20:00"
 */
export function recurrenceToText(rule: RecurrenceRule): string {
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const interval = rule.interval || 1;
  const { hour, minute } = rule;
  const timeStr = hour !== undefined && minute !== undefined
    ? ` ${formatReminderTime(hour, minute, rule.second, rule.millisecond)}`
    : '';

  if (rule.frequency === 'daily') {
    if (interval === 1) {
      return `daily${timeStr}`;
    }
    return `every ${interval} days${timeStr}`;
  }

  if (rule.frequency === 'weekly') {
    const days = rule.daysOfWeek && rule.daysOfWeek.length > 0
      ? rule.daysOfWeek.map(d => DAY_NAMES[d]).join(', ')
      : '';
    if (interval > 1 && days) {
      return `every ${interval} weeks on ${days}${timeStr}`;
    }
    // If specific days are set, use "every Mon, Wed, Fri" format
    if (rule.daysOfWeek && rule.daysOfWeek.length > 0) {
      return `every ${days}${timeStr}`;
    }
    // Otherwise use simple weekly/every N weeks
    if (interval === 1) {
      return `weekly${timeStr}`;
    }
    return `every ${interval} weeks${timeStr}`;
  }

  if (rule.frequency === 'monthly') {
    let base = interval === 1 ? 'monthly' : `every ${interval} months`;
    if (rule.dayOfMonth) {
      const suffix = getOrdinalSuffix(rule.dayOfMonth);
      base += ` on the ${rule.dayOfMonth}${suffix}`;
    }
    return base + timeStr;
  }

  return 'repeating';
}
