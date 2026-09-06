import { recurrenceToText } from './rruleConverter';
import type { RecurrenceRule } from '../types/reminder';
import { timezone as getLocalTimeZone } from './time';

export function getRecurrenceTimeZone(rule: RecurrenceRule | undefined): string {
  return rule?.timezone || getLocalTimeZone();
}

export function normalizeRecurrenceRule(rule: RecurrenceRule): RecurrenceRule;
export function normalizeRecurrenceRule(rule: null | undefined): undefined;
export function normalizeRecurrenceRule(
  rule: RecurrenceRule | null | undefined,
): RecurrenceRule | undefined;
export function normalizeRecurrenceRule(
  rule: RecurrenceRule | null | undefined,
): RecurrenceRule | undefined {
  if (!rule) {
    return undefined;
  }

  if (rule.timezone) {
    return rule;
  }

  return {
    ...rule,
    timezone: getRecurrenceTimeZone(rule),
  };
}

/** NLP describes visible recurrence fields; keep non-visible metadata on title edits. */
export function preserveRecurrenceMetadata(parsed: RecurrenceRule | undefined, previous: RecurrenceRule | undefined): RecurrenceRule | undefined {
  return parsed && previous && recurrenceToText(parsed) === recurrenceToText(previous) ? previous : parsed;
}
