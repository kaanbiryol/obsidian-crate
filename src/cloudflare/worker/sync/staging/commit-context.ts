import { isReminderPath } from '../../reminders/scope';
import { isReadingNotePath } from '../../reading/library-index';
import { MAX_REMINDER_NOTE_BYTES } from '../../../../reminders/core/constants';

/** The reminder policy fence and the folders that decide projection and Reading index work. */
export interface CommitFolders {
	policyRevision: string | null;
	reminderFolder: string | null;
	readingPolicy: { folder_path: string } | null;
}

/** One read under the coordinator lock, which every writer of these rows also holds. */
export async function readCommitFolders(db: D1Database): Promise<CommitFolders> {
	const row = await db.prepare(`SELECT p.revision, p.folder_path, r.folder_path AS reading_folder
    FROM (SELECT 1) LEFT JOIN notification_policy p ON p.id = 1 LEFT JOIN reading_policy r ON r.id = 1`)
		.first<{ revision: string | null; folder_path: string | null; reading_folder: string | null }>();
	return {
		policyRevision: row?.revision ?? null,
		reminderFolder: row?.folder_path ?? null,
		readingPolicy: row?.reading_folder ? { folder_path: row.reading_folder } : null,
	};
}

/** An upload whose bytes were read from R2 under an older reminder policy retries. Uploads
 * whose bytes traveled with the request record no revision and need no fence. */
export function policyFenceRefusal(readUnder: ReadonlyArray<string | null | undefined>, current: CommitFolders): Response | null {
	return readUnder.some(revision => revision !== undefined && revision !== current.policyRevision)
		? Response.json({ error: 'Reminder folder changed during upload. Retry the upload.' }, { status: 503 })
		: null;
}

/** Only reminder notes and plaintext Reading notes queue projection or index work.
 * Arming for others would add a full notification pass per commit. */
export function createsNotificationWork(paths: readonly string[], folders: Pick<CommitFolders, 'reminderFolder' | 'readingPolicy'>): boolean {
	const readingFolder = folders.readingPolicy?.folder_path ?? null;
	return paths.some(path => isReminderPath(path, folders.reminderFolder) || (readingFolder !== null && isReadingNotePath(path, readingFolder)));
}

/** Plaintext bytes matter to a commit only for a reminder note, and one over the limit is
 * rejected by its size, so its bytes stay in R2. */
export function needsStagedReminderBytes(file: { path: string; size: number }, reminderFolder: string | null): boolean {
	return isReminderPath(file.path, reminderFolder) && file.size <= MAX_REMINDER_NOTE_BYTES;
}
