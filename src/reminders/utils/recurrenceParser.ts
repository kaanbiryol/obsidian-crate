import type { RecurrenceFrequency, RecurrenceRule } from '../types/reminder';
import { normalizeRecurrenceRule } from './recurrenceRule';
import { parseRecurrenceTime } from './reminderTime';

const DAY_NAME_MAP: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const weekday = `(?:${Object.keys(DAY_NAME_MAP).join('|')})s?\\b\\.?`;
const weekdayRangeSeparator = '(?:\\s+(?:to|through|until|till)\\s+|\\s*[-–—]\\s*)';
const weekdayPart = `(?:weekdays?\\b|weekends?\\b|${weekday}(?:${weekdayRangeSeparator}${weekday})?)`;
// A separator belongs to the schedule only when another complete day follows.
const weekdays = `${weekdayPart}(?:(?:\\s*,\\s*(?:and\\s+)?|\\s+and\\s+)${weekdayPart})*`;
const intervalPattern = '(?:other|-?\\d+(?:\\.\\d+)?)';
const numberWord = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)';
const wordInterval = `${numberWord}(?:[\\s-]${numberWord})*`;
const namedTime = '(?:morning|afternoon|evening|night|noon|midday|midnight)';
const monthDay = '(?:\\s+on\\s+(?:the\\s+)?(?<day>\\d+(?:st|nd|rd|th)?|last\\s+day)\\b)?';

function frequencyPattern(unit: string, frequency: RecurrenceFrequency): string {
  return `(?:every\\s+(?<interval>${intervalPattern})\\s+${unit}s?|every\\s*${unit}|${frequency})\\b`;
}

const patterns: { frequency: RecurrenceFrequency; expression: RegExp; error?: string }[] = [
  {
    frequency: 'daily',
    expression: new RegExp(`\\bevery\\s+(?:(?<interval>${intervalPattern})\\s+)?(?<period>${namedTime})\\b`, 'gi'),
  },
  {
    frequency: 'daily',
    expression: new RegExp(`\\b${frequencyPattern('day', 'daily')}`, 'gi'),
  },
  {
    frequency: 'weekly',
    expression: new RegExp(`\\b${frequencyPattern('week', 'weekly')}(?:\\s+(?:on\\s+)?(?<days>${weekdays}))?`, 'gi'),
  },
  {
    frequency: 'weekly',
    expression: new RegExp(`\\bevery\\s+(?:(?<interval>${intervalPattern})\\s+)?(?<days>${weekdays})`, 'gi'),
  },
  {
    frequency: 'monthly',
    expression: new RegExp(`\\b${frequencyPattern('month', 'monthly')}${monthDay}`, 'gi'),
  },
  {
    // Recognize the whole unsupported cadence before Chrono can reinterpret
    // just its weekday or clock as a one-off reminder. Ordinary "every item"
    // prose is outside this deliberately narrow schedule grammar.
    frequency: 'daily',
    expression: new RegExp(`\\bevery\\s+${wordInterval}\\s+(?:days?|weeks?|months?|${weekdays}|${namedTime}s?)\\b(?:\\s+(?:on\\s+)?${weekdays})?${monthDay}`, 'gi'),
    error: 'Use digits for repeat intervals, such as every 2 weeks.',
  },
];

function parseWeekdays(text: string): number[] {
  const days: number[] = [];
  const dayNumber = (day: string) => DAY_NAME_MAP[day.toLowerCase().replace(/\.$/, '').replace(/s$/, '')]!;
  const parts = new RegExp(`(?<group>weekdays?|weekends?)\\b|(?<start>${weekday})(?:${weekdayRangeSeparator}(?<end>${weekday}))?`, 'gi');
  for (const match of text.matchAll(parts)) {
    const { group, start, end } = match.groups!;
    if (group) days.push(...(/^weekdays?$/i.test(group) ? [1, 2, 3, 4, 5] : [0, 6]));
    else {
      const first = dayNumber(start!);
      const length = end ? (dayNumber(end) - first + 7) % 7 + 1 : 1;
      for (let offset = 0; offset < length; offset++) days.push((first + offset) % 7);
    }
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

/**
 * Find a complete recurrence, including its optional weekday/month day and time.
 * Weekly forms accept "every Monday", "every week Monday", "weekly on Mon, Wed"
 * and "every 2 weeks on Mon, Wed". Monthly forms accept "monthly on the 15th"
 * and intervals. Times accept clocks or named periods such as "morning";
 * "every morning" and other named periods imply a daily repeat.
 * Invalid qualifiers remain part of the candidate so the editor can reject them.
 */
export interface RecurrenceCandidate {
  index: number;
  matched: string;
  rule: RecurrenceRule;
  error?: string;
}

/** Invalid qualifiers stay attached to their recurrence for editor validation. */
export function findRecurrenceCandidates(content: string, sourceText = content, referenceDate = new Date()): RecurrenceCandidate[] {
  const candidates: RecurrenceCandidate[] = [];
  for (const { frequency, expression, error: patternError } of patterns) {
    for (const match of content.matchAll(expression)) {
      const groups = match.groups!;
      const interval = groups.interval === undefined ? 1 : /^other$/i.test(groups.interval) ? 2 : Number(groups.interval);
      const rule = normalizeRecurrenceRule({ frequency });
      let error = patternError;
      if (!Number.isSafeInteger(interval) || interval < 1) error = 'Repeat intervals must be positive whole numbers.';
      if (interval > 1) rule.interval = interval;
      if (groups.days) rule.daysOfWeek = parseWeekdays(groups.days);
      // "Every other weekday" means alternating business days, not every
      // weekday in alternating weeks. Keep the whole phrase invalid.
      if (interval > 1 && /^every\s+(?:other|\d+)\s+weekdays?\b/i.test(match[0])) {
        error = 'Use every weekday, or specify a weekly interval and days.';
      }
      // The weekly calculator groups days in Sunday-based weeks; a multiweek
      // weekend would split Saturday and Sunday across different cycles.
      if (interval > 1 && /\bweekends?\b/i.test(groups.days ?? '')) {
        error = 'Use every weekend, or choose specific weekdays for a longer repeat interval.';
      }
      if (groups.day) {
        // Monthly day 31 is already clamped to each month's final day by the
        // recurrence calculator, including February in leap years.
        const day = /^last\s+day$/i.test(groups.day) ? 31 : Number.parseInt(groups.day, 10);
        if (!Number.isInteger(day) || day < 1 || day > 31) error = 'Choose a monthly day from 1 to 31.';
        else rule.dayOfMonth = day;
      }
      const timeIndex = match.index + match[0].length - (groups.period?.length ?? 0);
      let time = parseRecurrenceTime(content.slice(timeIndex), sourceText.slice(timeIndex), referenceDate);
      // "Every morning tomorrow" still has a complete daily cadence before
      // the later one-off date. Do not reduce it to a bare "every" token.
      if (groups.period && !time.text) time = parseRecurrenceTime(groups.period, groups.period, referenceDate);
      if (time.hour !== undefined) { rule.hour = time.hour; rule.minute = time.minute; }
      if (time.second !== undefined) rule.second = time.second;
      if (time.millisecond !== undefined) rule.millisecond = time.millisecond;
      if (time.timezone) rule.timezone = time.timezone;
      if (time.error) error = time.error;
      candidates.push({ index: match.index, matched: sourceText.slice(match.index, timeIndex + time.text.length), rule, ...(error ? { error } : {}) });
    }
  }
  return candidates.sort((a, b) => a.index - b.index);
}

export function parseRecurrenceFromContent(content: string): { matched: string; rule: RecurrenceRule } | null {
  const selected = findRecurrenceCandidates(content).find(candidate => !candidate.error);
  return selected ? { matched: selected.matched, rule: selected.rule } : null;
}
