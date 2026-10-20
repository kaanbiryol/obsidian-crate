import type { Reminder as SharedReminder } from '@/reminders/types/reminder';
import type { ReminderRecord } from '../../types';

// Unchanged records keep the same card data, so memoized cards skip re-rendering.
const sharedReminders = new WeakMap<ReminderRecord, SharedReminder>();

export function toSharedReminder(reminder: ReminderRecord): SharedReminder {
	let shared = sharedReminders.get(reminder);
	if (!shared) sharedReminders.set(reminder, shared = convertReminder(reminder));
	return shared;
}

function convertReminder(reminder: ReminderRecord): SharedReminder {
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
		if (!nextReminder) return reminder;
		// Keep unmoved records so their shared card data stays identical.
		return nextReminder.lineNumber === reminder.lineNumber ? nextReminder : { ...nextReminder, lineNumber: reminder.lineNumber };
	});
}

export function mergeProject(projects: string[], project: string): string[] {
	const normalized = project.trim() || 'Inbox';
	return projects.includes(normalized) ? projects : [...projects, normalized].sort((a, b) => a.localeCompare(b));
}

export function mergeReminderRecord(reminders: ReminderRecord[], record: ReminderRecord): ReminderRecord[] {
	return reminders.some(item => item.id === record.id)
		? reminders.map(item => item.id === record.id ? record : item)
		: [...reminders, record];
}

export type ReminderListEffect =
	| { kind: 'upsert'; record: ReminderRecord }
	| { kind: 'delete'; recordId: string }
	| { kind: 'reorder'; project: string; orderedIds: string[] };

export interface ReminderList { reminders: ReminderRecord[]; projects: string[] }

/** The one way a confirmed, settled or pending change alters the visible list. */
export function applyReminderListEffect(list: ReminderList, effect: ReminderListEffect): ReminderList {
	if (effect.kind === 'upsert') return { reminders: mergeReminderRecord(list.reminders, effect.record), projects: mergeProject(list.projects, effect.record.project) };
	if (effect.kind === 'delete') return { reminders: list.reminders.filter(item => item.id !== effect.recordId), projects: list.projects };
	return { reminders: reorderProjectReminders(list.reminders, effect.project, effect.orderedIds), projects: list.projects };
}
