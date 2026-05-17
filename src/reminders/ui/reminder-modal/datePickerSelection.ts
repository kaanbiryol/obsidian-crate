import { formatLocalDateKey, serializeReminderDateValue } from '../../utils/reminderDate';

export function buildDatePickerDateSelection(
  selectedDate: Date,
  existingDate: Date | null,
  hasTime: boolean,
): { value: string; hasTime: boolean } {
  const nextDate = new Date(selectedDate);

  if (hasTime) {
    nextDate.setHours(existingDate ? existingDate.getHours() : 9);
    nextDate.setMinutes(existingDate ? existingDate.getMinutes() : 0);
  } else {
    nextDate.setHours(0, 0, 0, 0);
  }

  return {
    value: serializeReminderDateValue(nextDate, hasTime) ?? formatLocalDateKey(nextDate),
    hasTime,
  };
}

export function buildDatePickerTimeSelection(
  hour: number,
  minute: number,
  existingDate: Date | null,
): { value: string; hasTime: true } {
  const nextDate = existingDate ? new Date(existingDate) : new Date();
  nextDate.setHours(hour, minute, 0, 0);

  return {
    value: serializeReminderDateValue(nextDate, true) ?? nextDate.toISOString(),
    hasTime: true,
  };
}
