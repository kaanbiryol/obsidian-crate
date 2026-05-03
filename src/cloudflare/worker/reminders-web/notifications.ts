import { parseReminderDateValue } from '@/reminders/utils/reminderDate';
import { cancelScheduledReminder, scheduleScheduledReminder } from '../reminder-handlers';
import type { Env } from '../types';
import type { RemoteReminderRecord } from './types';

function resolveNotificationDatetime(
	reminder: Pick<RemoteReminderRecord, 'dueDate' | 'dueDatetime'>,
	allDayNotificationTime: string | null | undefined,
): string | undefined {
	if (reminder.dueDatetime) {
		return reminder.dueDatetime;
	}

	if (!reminder.dueDate || !allDayNotificationTime) {
		return undefined;
	}

	const [hours, minutes] = allDayNotificationTime.split(':').map(Number);
	if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
		return undefined;
	}

	const date = parseReminderDateValue(reminder.dueDate, false);
	if (!date) {
		return undefined;
	}

	date.setHours(hours, minutes, 0, 0);
	return date.toISOString();
}

export async function syncReminderNotification(
	env: Env,
	reminder: RemoteReminderRecord | null,
	allDayNotificationTime: string | null | undefined,
): Promise<string | undefined> {
	if (!reminder) {
		return undefined;
	}

	try {
		const effectiveDatetime = resolveNotificationDatetime(reminder, allDayNotificationTime);
		if (!effectiveDatetime || reminder.completed || new Date(effectiveDatetime).getTime() <= Date.now()) {
			await cancelScheduledReminder(env, reminder.id);
			return undefined;
		}

		await scheduleScheduledReminder(env, {
			reminderId: reminder.id,
			content: reminder.content,
			project: reminder.project,
			dueDatetime: effectiveDatetime,
			priority: reminder.priority,
		});
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export async function cancelReminderNotification(env: Env, reminderId: string): Promise<string | undefined> {
	try {
		await cancelScheduledReminder(env, reminderId);
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
