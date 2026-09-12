import { recordFileFailure } from './notification-file-retries';
import { parseReminderSource } from './reminder-source-parse';
import { recordReminderSourceState } from './reminder-source-state';

/** File bytes, identity ownership and first observation share one commit. */
export function enqueueFileProjection(db: D1Database, path: string, storageKey: string | null, content: string | ArrayBuffer | null, preserveRetries = false): D1PreparedStatement[] {
  if (!path.toLowerCase().endsWith('.md')) return [];
  const guard = storageKey === null ? 'NOT EXISTS (SELECT 1 FROM files WHERE path = ?)'
    : 'EXISTS (SELECT 1 FROM files WHERE path = ? AND storage_key = ?)';
  const args = storageKey === null ? [path] : [path, storageKey];
  const token = crypto.randomUUID();
  const parsed = content === null ? { reminders: [], issue: undefined } : parseReminderSource(path, content);
  const reset = preserveRetries ? [] : [db.prepare(`DELETE FROM notification_file_retries WHERE path = ? AND ${guard}`).bind(path, ...args)];
  if (parsed.issue) {
    // Preserve the last verified identities and schedules. This quarantine is
    // published only when the new file revision commits in the same D1 batch.
    return [...reset, recordReminderSourceState(db, path, storageKey, false), db.prepare(`INSERT INTO notification_projection_jobs (path, job_token, last_error)
      SELECT ?, ?, ? WHERE ${guard}
      ON CONFLICT(path) DO UPDATE SET job_token = excluded.job_token,
        last_error = excluded.last_error, updated_at = datetime('now')`).bind(path, token, parsed.issue, ...args),
      recordFileFailure(db, path, parsed.issue, guard, args, true)];
  }
  const sources = new Map<string, { id: string; due: string; count: number }>();
  for (const reminder of parsed.reminders) {
    const prior = sources.get(reminder.id);
    if (prior) prior.count++;
    else sources.set(reminder.id, { id: reminder.id, due: reminder.dueDatetime ?? reminder.dueDate ?? '', count: 1 });
  }
  const json = JSON.stringify([...sources.values()]);
  return [
    ...reset,
    recordReminderSourceState(db, path, storageKey, true),
    // Revisit other owners on both collision and repair, including deletion.
    db.prepare(`INSERT INTO notification_projection_jobs (path, job_token)
      SELECT DISTINCT file_path, ? FROM reminder_sources WHERE reminder_id IN (
        SELECT reminder_id FROM reminder_sources WHERE file_path = ?
        UNION SELECT json_extract(value, '$.id') FROM json_each(?)) AND ${guard}
      ON CONFLICT(path) DO UPDATE SET job_token = excluded.job_token, last_error = NULL, updated_at = datetime('now')`)
      .bind(token, path, json, ...args),
    db.prepare(`DELETE FROM reminder_sources WHERE file_path = ?
      AND reminder_id NOT IN (SELECT json_extract(value, '$.id') FROM json_each(?)) AND ${guard}`).bind(path, json, ...args),
    db.prepare(`INSERT INTO reminder_sources (file_path, reminder_id, due_key, occurrences)
      SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.due'), json_extract(value, '$.count')
      FROM json_each(?) WHERE ${guard}
      ON CONFLICT(file_path, reminder_id) DO UPDATE SET
        due_key = excluded.due_key, occurrences = excluded.occurrences`).bind(path, json, ...args),
    db.prepare(`INSERT INTO reminder_occurrences (reminder_id, due_key, first_seen_at)
      SELECT json_extract(value, '$.id'), json_extract(value, '$.due'), ? FROM json_each(?)
      WHERE json_extract(value, '$.due') != '' AND ${guard}
      ON CONFLICT(reminder_id, due_key) DO NOTHING`).bind(Date.now(), json, ...args),
    db.prepare(`INSERT INTO notification_projection_jobs (path, job_token)
    SELECT ?, ? WHERE ${guard}
    ON CONFLICT(path) DO UPDATE SET job_token = excluded.job_token, last_error = NULL, updated_at = datetime('now')`)
      .bind(path, token, ...args),
  ];
}
