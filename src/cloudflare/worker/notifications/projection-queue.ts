import { readEncryptionState } from '../encryption/state';
import { FILE_PATH_MATCH, filePathArgs, fileRevisionGuard } from '../sync/file-identity';
import { recordFileFailure } from './file-retries';
import { parseReminderSource } from '../reminders/source-parse';
import { summarizeReminderSources } from '../reminders/source-summary';
import { recordReminderSourceState, sourcesChangedSql } from '../reminders/source-state';
import { sha256Hex } from '../../../platform/sha256';
import { getReminderFolder, isReminderPath } from '../reminders/scope';
import { isMarkdownPath } from '../../../protocol/note-paths';

export interface FileProjectionOptions {
	/** Keep the file's notification retry record instead of clearing it. */
	preserveRetries?: boolean;
	/** Whether the vault is encrypted; read when omitted. */
	encrypted?: boolean;
	/** The current reminders folder; read when omitted. */
	reminderFolder?: string | null;
	size?: number;
}

/** File bytes, identity ownership and first observation share one commit. */
export async function enqueueFileProjection(db: D1Database, path: string, storageKey: string | null, content: string | ArrayBuffer | null,
	{ preserveRetries = false, encrypted, reminderFolder, size }: FileProjectionOptions = {}): Promise<D1PreparedStatement[]> {
	// Only a Markdown note can be a reminder note; other files need no folder read.
	if (!isMarkdownPath(path)) return [];
	const folder = reminderFolder === undefined ? await getReminderFolder(db) : reminderFolder;
	if (!isReminderPath(path, folder)) return [];
	const { sql: guard, args } = storageKey === null
		? { sql: `NOT EXISTS (SELECT 1 FROM files WHERE ${FILE_PATH_MATCH})`, args: filePathArgs(path) }
		: fileRevisionGuard(path, storageKey);
	const token = crypto.randomUUID();
	const parsed = content === null ? { reminders: [], issue: undefined } : parseReminderSource(path, content, folder!, encrypted ?? (await readEncryptionState(db))?.mode === 'active', size);
	const reset = preserveRetries ? [] : [db.prepare(`DELETE FROM notification_file_retries WHERE path = ? AND ${guard}`).bind(path, ...args)];
	if (parsed.issue) {
		// Preserve the last verified identities and schedules. This quarantine is
		// published only when the new file revision commits in the same D1 batch.
		return [...reset, ...recordReminderSourceState(db, path, storageKey, false), db.prepare(`INSERT INTO notification_projection_jobs (path, job_token, last_error)
      SELECT ?, ?, ? WHERE ${guard}
      ON CONFLICT(path) DO UPDATE SET job_token = excluded.job_token,
        last_error = excluded.last_error, updated_at = datetime('now')`).bind(path, token, parsed.issue, ...args),
			recordFileFailure(db, path, parsed.issue, guard, args, true)];
	}
	const json = JSON.stringify(summarizeReminderSources(parsed.reminders));
	const digest = await sha256Hex(json);
	// An edit that keeps every reminder's ID, due key and count leaves the sources,
	// their owners and their occurrences as the last verified commit wrote them, so
	// these statements read and write nothing. The check reads the state before it changes.
	const changed = sourcesChangedSql(path, digest);
	const sources = `${guard} AND ${changed.sql}`, sourceArgs = [...args, ...changed.args];
	return [
		...reset,
		// Revisit other owners on both collision and repair, including deletion. This
		// file's own job is written below.
		db.prepare(`INSERT INTO notification_projection_jobs (path, job_token)
      SELECT DISTINCT file_path, ? FROM reminder_sources WHERE reminder_id IN (
        SELECT reminder_id FROM reminder_sources WHERE file_path = ?
        UNION SELECT json_extract(value, '$.id') FROM json_each(?)) AND file_path != ? AND ${sources}
      ON CONFLICT(path) DO UPDATE SET job_token = excluded.job_token, last_error = NULL, updated_at = datetime('now')`)
			.bind(token, path, json, path, ...sourceArgs),
		db.prepare(`DELETE FROM reminder_sources WHERE file_path = ?
      AND reminder_id NOT IN (SELECT json_extract(value, '$.id') FROM json_each(?)) AND ${sources}`).bind(path, json, ...sourceArgs),
		db.prepare(`INSERT INTO reminder_sources (file_path, reminder_id, due_key, occurrences)
      SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.due'), json_extract(value, '$.count')
      FROM json_each(?) WHERE ${sources}
      ON CONFLICT(file_path, reminder_id) DO UPDATE SET
        due_key = excluded.due_key, occurrences = excluded.occurrences
      WHERE reminder_sources.due_key IS NOT excluded.due_key OR reminder_sources.occurrences IS NOT excluded.occurrences`).bind(path, json, ...sourceArgs),
		db.prepare(`INSERT INTO reminder_occurrences (reminder_id, due_key, first_seen_at)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.due'), ? FROM json_each(?)
      WHERE json_extract(value, '$.due') != '' AND ${sources}
      ON CONFLICT(reminder_id, due_key) DO NOTHING`).bind(Date.now(), json, ...sourceArgs),
		...recordReminderSourceState(db, path, storageKey, true, digest),
		db.prepare(`INSERT INTO notification_projection_jobs (path, job_token)
    SELECT ?, ? WHERE ${guard}
    ON CONFLICT(path) DO UPDATE SET job_token = excluded.job_token, last_error = NULL, updated_at = datetime('now')`)
			.bind(path, token, ...args),
	];
}
