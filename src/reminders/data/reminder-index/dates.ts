import { formatLocalDateKey, isDateOnlyString, parseReminderDateValue } from "@/reminders/utils/reminderDate";

export function isReminderToday(dateStr: string | undefined): boolean {
  if (!dateStr) return false;
  if (isDateOnlyString(dateStr)) {
    return dateStr === formatLocalDateKey(new Date());
  }

  const date = new Date(dateStr);
  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate()
  );
}

export function isReminderWithinDays(dateStr: string | undefined, days: number): boolean {
  if (!dateStr) return false;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endDate = new Date(todayStart);
  endDate.setDate(endDate.getDate() + days + 1);

  if (isDateOnlyString(dateStr)) {
    const date = parseReminderDateValue(dateStr, false);
    if (!date) return false;

    const tomorrowStart = new Date(todayStart);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    return date >= tomorrowStart && date < endDate;
  }

  const date = new Date(dateStr);
  return date > now && date < endDate;
}

export function isReminderOverdue(dateStr: string | undefined, completed: boolean): boolean {
  if (!dateStr || completed) return false;
  if (isDateOnlyString(dateStr)) {
    return dateStr < formatLocalDateKey(new Date());
  }

  return new Date(dateStr) < new Date();
}
