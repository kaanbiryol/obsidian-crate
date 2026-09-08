const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ENGLISH_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Fixed English syntax for the reminder parser, independent of the UI locale. */
export function formatReminderDateText(date: Date, hasTime = false): string {
  if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid time value');
  const year = date.getFullYear();
  const day = `${ENGLISH_MONTHS[date.getMonth()]} ${date.getDate()}, ${String(year > 0 ? year : 1 - year).padStart(4, '0')}`;
  if (!hasTime) return day;
  return `${day} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function isDateOnlyString(value: string | null | undefined): value is string {
  return !!value && DATE_ONLY_PATTERN.test(value);
}

export function formatLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isReminderDueToday(input: {
  dueDate?: string;
  dueDatetime?: string;
}, now = new Date()): boolean {
  const todayKey = formatLocalDateKey(now);
  if (input.dueDatetime) {
    return formatLocalDateKey(new Date(input.dueDatetime)) === todayKey;
  }
  return input.dueDate === todayKey;
}

export function parseLocalDateKey(value: string): Date {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Invalid local date key: ${value}`);
  }

  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

export function inferHasTimeFromDate(date: Date | undefined): boolean {
  if (!date) {
    return false;
  }

  return (
    date.getHours() !== 0
    || date.getMinutes() !== 0
    || date.getSeconds() !== 0
    || date.getMilliseconds() !== 0
  );
}

export function parseReminderDateValue(
  value: string | null | undefined,
  hasTime?: boolean,
): Date | undefined {
  if (!value) {
    return undefined;
  }

  const resolvedHasTime = hasTime ?? !isDateOnlyString(value);
  return resolvedHasTime ? new Date(value) : parseLocalDateKey(value);
}

export function parseStoredReminderDate(input: {
  dueDate?: string;
  dueDatetime?: string;
}): Date | undefined {
  if (input.dueDatetime) {
    return new Date(input.dueDatetime);
  }

  return parseReminderDateValue(input.dueDate, false);
}

export function reminderHasTime(input: {
  dueDate?: string;
  dueDatetime?: string;
}): boolean | undefined {
  if (input.dueDatetime) {
    return true;
  }
  if (input.dueDate) {
    return false;
  }
  return undefined;
}

export function serializeReminderDateValue(
  date: Date | undefined,
  hasTime?: boolean,
): string | undefined {
  if (!date) {
    return undefined;
  }

  const resolvedHasTime = hasTime ?? inferHasTimeFromDate(date);
  return resolvedHasTime ? date.toISOString() : formatLocalDateKey(date);
}

export function buildStoredReminderDates(
  date: Date | undefined,
  hasTime?: boolean,
): { dueDate?: string; dueDatetime?: string } {
  if (!date) {
    return {};
  }

  const resolvedHasTime = hasTime ?? inferHasTimeFromDate(date);
  return {
    dueDate: resolvedHasTime ? date.toISOString().slice(0, 10) : formatLocalDateKey(date),
    dueDatetime: resolvedHasTime ? date.toISOString() : undefined,
  };
}
