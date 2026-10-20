import { getLocalTimeZone, today as todayIntl, type CalendarDate } from "@internationalized/date";

export function today(): CalendarDate {
  return todayIntl(getLocalTimeZone());
}

export function timezone(): string {
  return getLocalTimeZone();
}
