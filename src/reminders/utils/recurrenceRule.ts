import type { RecurrenceRule } from '../types/reminder';
import { timezone as getLocalTimeZone } from './time';

export function getRecurrenceTimeZone(rule: RecurrenceRule | undefined): string {
  return rule?.timezone || getLocalTimeZone();
}

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
