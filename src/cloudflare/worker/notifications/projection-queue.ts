import { readEncryptionState } from '../encryption/state';
import { FILE_PATH_MATCH, filePathArgs, fileRevisionGuard } from '../sync/file-identity';
import { recordFileFailure } from './file-retries';
import { parseReminderSource } from '../reminders/source-parse';
import { summarizeReminderSources } from '../reminders/source-summary';
import { recordReminderSourceState, reminderSourcesDigest, sourcesChangedSql } from '../reminders/source-state';
import { getReminderFolder, isReminderPath } from '../reminders/scope';
import { isMarkdownPath } from '../../../protocol/note-paths';
import { rememberCommittedSource } from './committed-sources';

export interface FileProjectionOptions {
	/** Keep the file's notification retry record instead of clearing it. */
	preserveRetries?: boolean;
	/** Whether the vault is encrypted; read when omitted. */
	encrypted?: boolean;
	/** The current reminders folder; read when omitted. */
	reminderFolder?: string | null;
	size?: number;
	/** Check every reminder's projection row again instead of trusting the note's snapshot,
	 * as after a parser upgrade, which can change what a row should hold. */
	recheck?: boolean;
	/** Keep the bytes for the projection that follows. Re-verification passes its own. */
	cacheBytes?: boolean;
}

/** File bytes, identity ownership and first observation share one commit. */
export async function enqueueFileProjection(db: D1Database, path: string, storageKey: string | null, content: string | ArrayBuffer | null,
	{ preserveRetries = false, encrypted, reminderFolder, size, recheck = false, cacheBytes = true }: FileProjectionOptions = {}): Promise<D1PreparedStatement[]> {
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
	const summary = summarizeReminderSources(parsed.reminders);
	const json = JSON.stringify(summary);
	const digest = await reminderSourcesDigest(summary, json);
	if (cacheBytes && storageKey !== null && content !== null) rememberCommittedSource(storageKey, content);
	// An edit that keeps every reminder's ID, due key and count leaves the sources and their
	// occurrences as the last verified commit wrote them, and one that keeps every ID leaves
	// their owners. The note key or summary below is then NULL, so a statement looks up no
	// row. The checks read the state before it changes.
	const unless = (identitiesOnly: boolean) => {
		const changed = sourcesChangedSql(path, digest, identitiesOnly);
		return { sql: `(SELECT ? WHERE ${guard} AND ${changed.sql})`, args: [...args, ...changed.args] };
	};
	const sources = unless(false), identities = unless(true);
	return [
		...reset,
		// This file's job. A commit that adds or removes one of its reminders also checks every
		// identity again: its snapshot may predate a move away and back that another note's job
		// projected in between. Written first, while the source state is still the last commit's.
		db.prepare(`INSERT INTO notification_projection_jobs (path, job_token, recheck)
    SELECT ?, ?, max(?, ${identities.sql} IS NOT NULL) WHERE ${guard}
    ON CONFLICT(path) DO UPDATE SET job_token = excluded.job_token, last_error = NULL,
      recheck = max(notification_projection_jobs.recheck, excluded.recheck), updated_at = datetime('now')`)
			.bind(path, token, recheck ? 1 : 0, json, ...identities.args, ...args),
		// Revisit the other owners of reminders that join or leave this note, including on
		// deletion. Their projection then checks every identity again, so a duplicate quarantines
		// both notes.
		db.prepare(`INSERT INTO notification_projection_jobs (path, job_token, recheck)
      SELECT DISTINCT file_path, ?, 1 FROM reminder_sources WHERE reminder_id IN (
        SELECT json_extract(value, '$.id') FROM json_each(${identities.sql}) WHERE NOT EXISTS (
          SELECT 1 FROM reminder_sources o WHERE o.file_path = ? AND o.reminder_id = json_extract(value, '$.id'))
        UNION ALL SELECT reminder_id FROM reminder_sources WHERE file_path = ${identities.sql}
          AND reminder_id NOT IN (SELECT json_extract(value, '$.id') FROM json_each(?))) AND file_path != ?
      ON CONFLICT(path) DO UPDATE SET job_token = excluded.job_token, last_error = NULL, recheck = 1, updated_at = datetime('now')`)
			.bind(token, json, ...identities.args, path, path, ...identities.args, json, path),
		db.prepare(`DELETE FROM reminder_sources WHERE file_path = ${identities.sql}
      AND reminder_id NOT IN (SELECT json_extract(value, '$.id') FROM json_each(?))`).bind(path, ...identities.args, json),
		db.prepare(`INSERT INTO reminder_sources (file_path, reminder_id, due_key, occurrences)
      SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.due'), json_extract(value, '$.count')
      FROM json_each(${sources.sql}) WHERE 1
      ON CONFLICT(file_path, reminder_id) DO UPDATE SET
        due_key = excluded.due_key, occurrences = excluded.occurrences
      WHERE reminder_sources.due_key IS NOT excluded.due_key OR reminder_sources.occurrences IS NOT excluded.occurrences`).bind(path, json, ...sources.args),
		db.prepare(`INSERT INTO reminder_occurrences (reminder_id, due_key, first_seen_at)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.due'), ? FROM json_each(${sources.sql})
      WHERE json_extract(value, '$.due') != ''
      ON CONFLICT(reminder_id, due_key) DO NOTHING`).bind(Date.now(), json, ...sources.args),
		...recordReminderSourceState(db, path, storageKey, true, digest),
	];
}
