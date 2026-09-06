import { scanReminderMarkdownFile } from './reminders-web/scan';
import { REMINDER_INDEX_MAX_FILE_BYTES } from './reminders-web/reminder-cache/types';

/** File bytes, identity ownership and first observation share one commit. */
export function enqueueFileProjection(db: D1Database, path: string, storageKey: string | null, content: string | ArrayBuffer | null): D1PreparedStatement[] {
  if (!path.toLowerCase().endsWith('.md')) return [];
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const reminders = bytes && bytes.byteLength <= REMINDER_INDEX_MAX_FILE_BYTES
    ? scanReminderMarkdownFile(path, new TextDecoder().decode(bytes), '') : [];
  const sources = new Map<string, { id: string; due: string; count: number }>();
  for (const reminder of reminders) {
    const prior = sources.get(reminder.id);
    if (prior) prior.count++;
    else sources.set(reminder.id, { id: reminder.id, due: reminder.dueDatetime ?? reminder.dueDate ?? '', count: 1 });
  }
  const json = JSON.stringify([...sources.values()]);
  const guard = storageKey === null ? 'NOT EXISTS (SELECT 1 FROM files WHERE path = ?)'
    : 'EXISTS (SELECT 1 FROM files WHERE path = ? AND storage_key = ?)';
  const args = storageKey === null ? [path] : [path, storageKey];
  const token = crypto.randomUUID();
  return [
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
