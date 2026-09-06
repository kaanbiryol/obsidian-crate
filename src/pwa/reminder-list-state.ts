import type { Reminder as SharedReminder } from '@/reminders/types/reminder';
import type { ReminderRecord } from './types';

export function toSharedReminder(reminder: ReminderRecord): SharedReminder {
	return {
		id: reminder.id,
		content: reminder.content,
		description: reminder.description,
		dueDate: reminder.dueDate,
		dueDatetime: reminder.dueDatetime,
		priority: reminder.priority,
		completed: reminder.completed,
		project: reminder.project || 'Inbox',
		recurrence: reminder.recurrence,
		fileLink: reminder.filePath,
		lineNumber: reminder.lineNumber,
	};
}

export function reorderProjectReminders(reminders: ReminderRecord[], project: string, orderedIds: string[]): ReminderRecord[] {
	const order = new Map(orderedIds.map((id, index) => [id, index]));
	const activeProjectReminders = reminders
		.filter((reminder) => reminder.project === project && !reminder.completed)
		.sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER));

	let activeIndex = 0;
	return reminders.map((reminder) => {
		if (reminder.project !== project || reminder.completed) return reminder;
		const nextReminder = activeProjectReminders[activeIndex];
		activeIndex += 1;
		return nextReminder ? { ...nextReminder, lineNumber: reminder.lineNumber } : reminder;
	});
}

export function mergeProject(projects: string[], project: string): string[] {
	const normalized = project.trim() || 'Inbox';
	return projects.includes(normalized) ? projects : [...projects, normalized].sort((a, b) => a.localeCompare(b));
}
