export const REMINDER_DATE_PRESETS = [
	{ id: 'today', label: 'Today' },
	{ id: 'tomorrow', label: 'Tomorrow' },
	{ id: 'evening', label: 'This evening' },
	{ id: 'next-week', label: 'Next week' },
] as const;

export type ReminderDatePreset = typeof REMINDER_DATE_PRESETS[number]['id'];

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
