import { validateRecurrence } from '@/reminders/core/validateRecurrence';
import type { ModalDraft, ReminderRecord } from './types';

function isStoredCalendarDate(value: unknown): value is string {
	return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
		&& new Date(value).toISOString().slice(0, 10) === value;
}

export function isStoredReminderRecord(value: unknown, folderPath: string): value is ReminderRecord {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const record = value as Partial<ReminderRecord>;
	if (typeof record.id !== 'string' || !record.id || typeof record.content !== 'string' || typeof record.project !== 'string'
		|| typeof record.completed !== 'boolean' || ![1, 4].includes(record.priority ?? 0)
		|| typeof record.filePath !== 'string' || !record.filePath.startsWith(`${folderPath}/`)
		|| !record.filePath.toLowerCase().endsWith('.md') || record.filePath.includes('\\')
		|| Array.from(record.filePath).some(char => char.charCodeAt(0) < 32)
		|| record.filePath.split('/').some(part => !part || part === '.' || part === '..')
		|| (record.description !== undefined && typeof record.description !== 'string')
		|| (record.revision !== undefined && typeof record.revision !== 'string')
		|| (record.lineNumber !== undefined && (!Number.isSafeInteger(record.lineNumber) || record.lineNumber < 0))
		|| (record.dueDate !== undefined && !isStoredCalendarDate(record.dueDate))) return false;
	if (record.dueDatetime !== undefined && (typeof record.dueDatetime !== 'string'
		|| !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(record.dueDatetime)
		|| !isStoredCalendarDate(record.dueDatetime.slice(0, 10)) || !Number.isFinite(Date.parse(record.dueDatetime)))) return false;
	return record.recurrence === undefined || !('error' in validateRecurrence(record.recurrence));
}

export function isStoredReminderDraft(value: unknown): value is ModalDraft {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const draft = value as Partial<ModalDraft>;
	return ['content', 'description', 'project', 'defaultProject', 'dueDate', 'dueTime']
		.every(field => typeof draft[field as keyof ModalDraft] === 'string')
		&& (draft.priority === 1 || draft.priority === 4)
		&& (draft.activePicker === null || ['date', 'project', 'recurrence'].includes(String(draft.activePicker)))
		&& typeof draft.deleteConfirm === 'boolean'
		&& (draft.originalDueDatetime === undefined || typeof draft.originalDueDatetime === 'string')
		&& (draft.recurrence === undefined || !('error' in validateRecurrence(draft.recurrence)));
}
