import { validateRecurrence } from '@/reminders/core/validateRecurrence';
import { parseReminderSourceIssues } from './reminder-source-issues';
import type { CachedReminderSnapshot, ReminderRecord } from './types';

function calendarDate(value: unknown): value is string {
	return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
		&& new Date(value).toISOString().slice(0, 10) === value;
}

function validReminder(value: unknown, folderPath: string): value is ReminderRecord {
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
		|| (record.dueDate !== undefined && !calendarDate(record.dueDate))) return false;
	if (record.dueDatetime !== undefined && (typeof record.dueDatetime !== 'string'
		|| !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(record.dueDatetime)
		|| !calendarDate(record.dueDatetime.slice(0, 10)) || !Number.isFinite(Date.parse(record.dueDatetime)))) return false;
	return record.recurrence === undefined || !('error' in validateRecurrence(record.recurrence));
}

/** Reject the entire damaged revision so its ETag cannot hide missing records. */
export function normalizeSnapshot(value: unknown, folderPath: string): CachedReminderSnapshot | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const snapshot = value as Partial<CachedReminderSnapshot>;
	// Legacy snapshots lack completeness metadata and need a fresh full response.
	if (snapshot.issues === undefined) return null;
	const issues = parseReminderSourceIssues(snapshot.issues);
	if (issues === null || snapshot.folderPath !== folderPath || !Array.isArray(snapshot.reminders)
		|| !snapshot.reminders.every(record => validReminder(record, folderPath))
		|| new Set(snapshot.reminders.map(record => record.id)).size !== snapshot.reminders.length
		|| !Array.isArray(snapshot.projects) || !snapshot.projects.every(project => typeof project === 'string')
		|| typeof snapshot.savedAt !== 'number' || !Number.isFinite(snapshot.savedAt) || snapshot.savedAt < 0
		|| (snapshot.etag !== undefined && typeof snapshot.etag !== 'string')) return null;
	return { folderPath, reminders: snapshot.reminders, projects: snapshot.projects, savedAt: snapshot.savedAt, etag: snapshot.etag, issues };
}
