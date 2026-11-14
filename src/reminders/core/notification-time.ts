import { parseDateTime, toZoned } from '@internationalized/date';

/** How long after its due time a notification may still be delivered, by the Worker or locally. */
export const NOTIFICATION_DELIVERY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** When a reminder notifies: its due time, or an all-day reminder at `allDayTime` in `timezone`.
 * Undefined when it has no due date, or is all-day and all-day notifications are off. */
export function notificationDatetime(
	reminder: { dueDate?: string | null; dueDatetime?: string | null },
	schedule: { allDayTime: string | null; timezone: string },
): string | undefined {
	if (reminder.dueDatetime) return reminder.dueDatetime;
	if (!reminder.dueDate || !schedule.allDayTime) return undefined;
	return toZoned(parseDateTime(`${reminder.dueDate}T${schedule.allDayTime}`), schedule.timezone).toDate().toISOString();
}
