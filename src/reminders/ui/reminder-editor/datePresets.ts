import { formatLocalDateKey, serializeReminderDateValue } from '../../core/dates/reminderDate';

export const REMINDER_DATE_PRESETS = [
	{ id: 'today', label: 'Today', hasTime: false },
	{ id: 'tomorrow', label: 'Tomorrow', hasTime: false },
	{ id: 'evening', label: 'This evening', hasTime: true },
	{ id: 'next-week', label: 'Next week', hasTime: false },
] as const;

export type ReminderDatePreset = typeof REMINDER_DATE_PRESETS[number]['id'];

export function reminderDatePresetHasTime(preset: ReminderDatePreset): boolean {
	return REMINDER_DATE_PRESETS.some(entry => entry.id === preset && entry.hasTime);
}

export function getReminderDateForPreset(
	preset: ReminderDatePreset,
	now: Date = new Date(),
): Date {
	const date = new Date(now);
	if (preset === 'tomorrow') date.setDate(date.getDate() + 1);
	if (preset === 'evening' && date.getHours() >= 18) date.setDate(date.getDate() + 1);
	if (preset === 'next-week') date.setDate(date.getDate() + 7);
	date.setHours(preset === 'evening' ? 18 : 0, 0, 0, 0);
	return date;
}

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
