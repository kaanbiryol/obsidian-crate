import { parseReminderDateValue } from '@/reminders/utils/reminderDate';
import {
	enqueueCancelNotification,
	enqueueScheduleNotification,
	processNotificationJob,
} from '../notification-outbox';
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

	date.setHours(hours ?? 0, minutes ?? 0, 0, 0);
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
			const token = await enqueueCancelNotification(env.DB, reminder.id);
			return await processNotificationJob(env, reminder.id, token);
		}

		const token = await enqueueScheduleNotification(env.DB, {
			reminderId: reminder.id,
			content: reminder.content,
			project: reminder.project,
			dueDatetime: effectiveDatetime,
			priority: reminder.priority,
		});
		return await processNotificationJob(env, reminder.id, token);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

export async function cancelReminderNotification(env: Env, reminderId: string): Promise<string | undefined> {
	try {
		const token = await enqueueCancelNotification(env.DB, reminderId);
		return await processNotificationJob(env, reminderId, token);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}
