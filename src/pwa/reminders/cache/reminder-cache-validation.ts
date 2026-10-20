import { isReminderList, isScopedReminderList } from './reminder-storage-validation';
import { parseReminderSourceIssues } from './reminder-source-issues';
import type { CachedReminderSnapshot } from '../../types';

/** Reject the entire damaged revision so its ETag cannot hide missing records.
 * `recordsValidated` is only for in-memory records that each passed reminder validation. */
export function normalizeSnapshot(value: unknown, folderPath: string, recordsValidated = false): CachedReminderSnapshot | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const snapshot = value as Partial<CachedReminderSnapshot>;
	// Snapshots without completeness metadata need a fresh full response.
	if (snapshot.issues === undefined) return null;
	const issues = parseReminderSourceIssues(snapshot.issues);
	const { reminders } = snapshot;
	if (!Array.isArray(reminders) || !(recordsValidated ? isScopedReminderList(reminders, folderPath) : isReminderList(reminders, folderPath))) return null;
	if (issues === null || snapshot.folderPath !== folderPath
		|| !Array.isArray(snapshot.projects) || !snapshot.projects.every(project => typeof project === 'string')
		|| typeof snapshot.savedAt !== 'number' || !Number.isFinite(snapshot.savedAt) || snapshot.savedAt < 0
		|| (snapshot.etag !== undefined && typeof snapshot.etag !== 'string')
		|| (snapshot.deltaBase !== undefined && (typeof snapshot.deltaBase !== 'string' || snapshot.deltaBase.length > 128))) return null;
	return { folderPath, reminders, projects: snapshot.projects, savedAt: snapshot.savedAt, etag: snapshot.etag,
		...(snapshot.deltaBase === undefined ? {} : { deltaBase: snapshot.deltaBase }), issues };
}
