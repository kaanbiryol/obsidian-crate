import { portablePathKey } from '../../protocol/portable-path';
import { parseReminderSource } from './reminder-source-parse';
import { REMINDER_CACHE_PARSER_VERSION } from './reminders-web/reminder-cache/types';
import { getReminderFolder, isReminderPath } from './reminder-scope';

/** The same source/identity publication as a single upload, grouped by live revision. */
export async function bulkFileProjection(db: D1Database, files: Array<{ path: string; objectKey: string; content: ArrayBuffer }>): Promise<D1PreparedStatement[]> {
  const folder = await getReminderFolder(db);
  const rows = files.filter(file => isReminderPath(file.path, folder)).map(file => {
    const parsed = parseReminderSource(file.path, file.content, folder!);
    const sources = new Map<string, { id: string; due: string; count: number }>();
    for (const reminder of parsed.reminders) {
      const prior = sources.get(reminder.id);
      if (prior) prior.count++;
      else sources.set(reminder.id, { id: reminder.id, due: reminder.dueDatetime ?? reminder.dueDate ?? '', count: 1 });
    }
    return { path: file.path, portable: portablePathKey(file.path), key: file.objectKey, issue: parsed.issue ?? null, sources: [...sources.values()] };
  });
  if (!rows.length) return [];
  const json = JSON.stringify(rows);
  const token = crypto.randomUUID();
  const cte = `WITH input AS (SELECT json_extract(value, '$.path') AS path, json_extract(value, '$.portable') AS portable, json_extract(value, '$.key') AS storage_key,
    json_extract(value, '$.issue') AS issue, json_extract(value, '$.sources') AS sources FROM json_each(?)),
    live AS (SELECT i.* FROM input i JOIN files f ON f.portable_path = i.portable AND f.path = i.path AND f.storage_key = i.storage_key),
    valid AS (SELECT * FROM live WHERE issue IS NULL),
    sources AS (SELECT v.path, json_extract(s.value, '$.id') AS id, json_extract(s.value, '$.due') AS due,
      json_extract(s.value, '$.count') AS occurrences FROM valid v, json_each(v.sources) s) `;
  const statement = (sql: string, ...args: (string | number)[]) => db.prepare(cte + sql).bind(json, ...args);
  return [
    statement('DELETE FROM notification_file_retries WHERE path IN (SELECT path FROM live)'),
    statement(`INSERT INTO reminder_source_state(file_path, file_revision, parser_version, verified)
      SELECT path, storage_key, ?, issue IS NULL FROM live WHERE 1
      ON CONFLICT(file_path) DO UPDATE SET file_revision = excluded.file_revision, parser_version = excluded.parser_version,
        verified = excluded.verified, updated_at = datetime('now')`, REMINDER_CACHE_PARSER_VERSION),
    statement(`INSERT INTO notification_projection_jobs(path, job_token)
      SELECT DISTINCT file_path, ? FROM reminder_sources WHERE reminder_id IN (
        SELECT reminder_id FROM reminder_sources WHERE file_path IN (SELECT path FROM valid) UNION SELECT id FROM sources)
      ON CONFLICT(path) DO UPDATE SET job_token = excluded.job_token, last_error = NULL, updated_at = datetime('now')`, token),
    statement(`DELETE FROM reminder_sources WHERE file_path IN (SELECT path FROM valid)
      AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.path = reminder_sources.file_path AND s.id = reminder_sources.reminder_id)`),
    statement(`INSERT INTO reminder_sources(file_path, reminder_id, due_key, occurrences)
      SELECT path, id, due, occurrences FROM sources WHERE 1
      ON CONFLICT(file_path, reminder_id) DO UPDATE SET due_key = excluded.due_key, occurrences = excluded.occurrences`),
    statement(`INSERT INTO reminder_occurrences(reminder_id, due_key, first_seen_at)
      SELECT id, due, ? FROM sources WHERE due != '' ON CONFLICT(reminder_id, due_key) DO NOTHING`, Date.now()),
    statement(`INSERT INTO notification_projection_jobs(path, job_token, last_error)
      SELECT path, ?, issue FROM live WHERE issue IS NOT NULL
        OR EXISTS (SELECT 1 FROM sources s WHERE s.path = live.path)
        OR EXISTS (SELECT 1 FROM reminder_projections p WHERE p.file_path = live.path)
        OR EXISTS (SELECT 1 FROM notification_projection_jobs j WHERE j.path = live.path)
      ON CONFLICT(path) DO UPDATE SET job_token = excluded.job_token,
        last_error = excluded.last_error, updated_at = datetime('now')`, token),
    statement(`INSERT INTO notification_file_retries(path, attempts, available_at, error)
      SELECT path, 1, -1, substr(issue, 1, 512) FROM live WHERE issue IS NOT NULL
      ON CONFLICT(path) DO UPDATE SET attempts = attempts + 1, available_at = -1, error = excluded.error`),
  ];
}
