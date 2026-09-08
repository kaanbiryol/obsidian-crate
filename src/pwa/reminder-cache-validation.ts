import { isStoredReminderRecord } from './reminder-storage-validation';
import { parseReminderSourceIssues } from './reminder-source-issues';
import type { CachedReminderSnapshot } from './types';

/** Reject the entire damaged revision so its ETag cannot hide missing records. */
export function normalizeSnapshot(value: unknown, folderPath: string): CachedReminderSnapshot | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const snapshot = value as Partial<CachedReminderSnapshot>;
	// Legacy snapshots lack completeness metadata and need a fresh full response.
	if (snapshot.issues === undefined) return null;
	const issues = parseReminderSourceIssues(snapshot.issues);
	if (issues === null || snapshot.folderPath !== folderPath || !Array.isArray(snapshot.reminders)
		|| !snapshot.reminders.every(record => isStoredReminderRecord(record, folderPath))
		|| new Set(snapshot.reminders.map(record => record.id)).size !== snapshot.reminders.length
		|| !Array.isArray(snapshot.projects) || !snapshot.projects.every(project => typeof project === 'string')
		|| typeof snapshot.savedAt !== 'number' || !Number.isFinite(snapshot.savedAt) || snapshot.savedAt < 0
		|| (snapshot.etag !== undefined && typeof snapshot.etag !== 'string')) return null;
	return { folderPath, reminders: snapshot.reminders, projects: snapshot.projects, savedAt: snapshot.savedAt, etag: snapshot.etag, issues };
}
