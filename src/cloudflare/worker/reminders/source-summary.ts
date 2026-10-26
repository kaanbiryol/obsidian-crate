import type { RemoteReminderRecord } from './types';

/** Keep duplicate counts and the first observed due key identical across commit paths. */
export function summarizeReminderSources(reminders: readonly Pick<RemoteReminderRecord, 'id' | 'dueDate' | 'dueDatetime'>[]) {
	const sources = new Map<string, { id: string; due: string; count: number }>();
	for (const reminder of reminders) {
		const prior = sources.get(reminder.id);
		if (prior) prior.count++;
		else sources.set(reminder.id, { id: reminder.id, due: reminder.dueDatetime ?? reminder.dueDate ?? '', count: 1 });
	}
	return [...sources.values()];
}
