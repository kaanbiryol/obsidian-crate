import type { Reminder } from '../types/reminder';

/** Hash only domain state, excluding line positions, caches and presentation. */
export async function reminderRevision(reminder: Reminder & { filePath?: string }): Promise<string> {
	const rule = reminder.recurrence;
	const value = JSON.stringify([
		reminder.id, reminder.filePath ?? '', reminder.content, reminder.description ?? '',
		reminder.dueDate ?? null, reminder.dueDatetime ?? null, reminder.priority,
		reminder.completed, reminder.project ?? 'Inbox',
		rule ? [rule.frequency, rule.interval ?? 1, [...(rule.daysOfWeek ?? [])].sort(), rule.dayOfMonth ?? null,
			rule.endDate ?? null, rule.count ?? null, rule.completedCount ?? 0,
			rule.hour ?? null, rule.minute ?? null, rule.timezone ?? null] : null,
	]);
	const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
