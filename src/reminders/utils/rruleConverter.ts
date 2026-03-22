import type { RecurrenceRule, RecurrenceFrequency } from '../types/reminder';

// Map our frequency to iCalendar FREQ values
const FREQ_MAP: Record<RecurrenceFrequency, string> = {
  daily: 'DAILY',
  weekly: 'WEEKLY',
  monthly: 'MONTHLY',
};

// iCalendar day abbreviations (Sunday = 0 in JS Date)
const DAY_MAP = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/**
 * Convert a RecurrenceRule to an iCalendar RRULE string.
 *
 * Examples:
 * - { frequency: 'daily' } => "FREQ=DAILY"
 * - { frequency: 'weekly', daysOfWeek: [1, 3, 5] } => "FREQ=WEEKLY;BYDAY=MO,WE,FR"
 * - { frequency: 'monthly', dayOfMonth: 15 } => "FREQ=MONTHLY;BYMONTHDAY=15"
 * - { frequency: 'weekly', interval: 2 } => "FREQ=WEEKLY;INTERVAL=2"
 */
export function recurrenceToRRule(rule: RecurrenceRule): string {
  const parts: string[] = [`FREQ=${FREQ_MAP[rule.frequency]}`];

  // Add interval if not 1 (default)
  if (rule.interval && rule.interval > 1) {
    parts.push(`INTERVAL=${rule.interval}`);
  }

  // Add BYDAY for weekly recurrence with specific days
  if (rule.frequency === 'weekly' && rule.daysOfWeek && rule.daysOfWeek.length > 0) {
    const days = rule.daysOfWeek.map(d => DAY_MAP[d]).join(',');
    parts.push(`BYDAY=${days}`);
  }

  // Add BYMONTHDAY for monthly recurrence
  if (rule.frequency === 'monthly' && rule.dayOfMonth) {
    parts.push(`BYMONTHDAY=${rule.dayOfMonth}`);
  }

  // Add UNTIL if end date specified
  if (rule.endDate) {
    // Convert ISO date to iCalendar format (YYYYMMDD or YYYYMMDDTHHMMSSZ)
    const endStr = rule.endDate.replace(/[-:]/g, '').split('.')[0];
    // Ensure it ends with Z for UTC
    const until = endStr.includes('T') ? (endStr.endsWith('Z') ? endStr : endStr + 'Z') : endStr;
    parts.push(`UNTIL=${until}`);
  }

  // Add COUNT if max occurrences specified
  if (rule.count) {
    parts.push(`COUNT=${rule.count}`);
  }

  return parts.join(';');
}

/**
 * Parse an iCalendar RRULE string into a RecurrenceRule object.
 * Returns null if the RRULE cannot be parsed or uses unsupported features.
 *
 * Examples:
 * - "FREQ=DAILY" => { frequency: 'daily' }
 * - "FREQ=WEEKLY;BYDAY=MO,WE,FR" => { frequency: 'weekly', daysOfWeek: [1, 3, 5] }
 * - "FREQ=MONTHLY;BYMONTHDAY=15" => { frequency: 'monthly', dayOfMonth: 15 }
 */
/**
 * Format time as HH:MM in 24-hour format
 */
function formatTime(hour: number, minute: number): string {
  const hourStr = hour.toString().padStart(2, '0');
  const minuteStr = minute.toString().padStart(2, '0');
  return `${hourStr}:${minuteStr}`;
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
  const hasTime = rule.hour !== undefined && rule.minute !== undefined;
  const timeStr = hasTime ? ` at ${formatTime(rule.hour!, rule.minute!)}` : '';

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
  return s[(v - 20) % 10] || s[v] || s[0];
}

/**
 * Format time as HH:MM in 24-hour format for natural language (parsing-friendly)
 */
function formatTime24(hour: number, minute: number): string {
  const hourStr = hour.toString().padStart(2, '0');
  const minuteStr = minute.toString().padStart(2, '0');
  return `${hourStr}:${minuteStr}`;
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
  const hasTime = rule.hour !== undefined && rule.minute !== undefined;
  const timeStr = hasTime ? ` ${formatTime24(rule.hour!, rule.minute!)}` : '';

  if (rule.frequency === 'daily') {
    if (interval === 1) {
      return `daily${timeStr}`;
    }
    return `every ${interval} days${timeStr}`;
  }

  if (rule.frequency === 'weekly') {
    // If specific days are set, use "every Mon, Wed, Fri" format
    if (rule.daysOfWeek && rule.daysOfWeek.length > 0) {
      const days = rule.daysOfWeek.map(d => DAY_NAMES[d]).join(', ');
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
