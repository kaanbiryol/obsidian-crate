import { queryRows } from './db';
import { enqueueFileProjection } from './notification-projection-queue';
import { recordReminderSourceState } from './reminder-source-state';
import { readStoredMarkdownFiles, type StoredMarkdownFileMetadata } from './storage';
import { REMINDER_SOURCE_SIZE_ISSUE } from './reminder-source-parse';
import { REMINDER_CACHE_PARSER_VERSION, REMINDER_INDEX_MAX_FILE_BYTES } from './reminders-web/reminder-cache/types';
import type { Env } from './types';

const SCAN_KEY = 'reminder_source_scan';
const SCAN_BATCH_SIZE = 100;
const MAX_REPARSE_BYTES = 2 * 1024 * 1024;

/** Walk the indexed Markdown namespace in bounded pages, including writes from an old serving Worker during upgrade. */
async function seedSourceStates(db: D1Database): Promise<boolean> {
  const saved = await db.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(SCAN_KEY).first<{ value: string }>();
  const cursor = saved?.value ?? '';
  const files = await queryRows<{ path: string }>(db.prepare(`SELECT path FROM files
    WHERE lower(path) LIKE '%.md' AND path > ? ORDER BY path LIMIT ?`).bind(cursor, SCAN_BATCH_SIZE));
  const next = files.length === SCAN_BATCH_SIZE ? files[files.length - 1]!.path : '';
  await db.batch([
    db.prepare(`DELETE FROM reminder_source_state WHERE file_path IN (
      SELECT file_path FROM reminder_source_state WHERE parser_version < ? ORDER BY parser_version, file_path LIMIT ?)
      AND NOT EXISTS (SELECT 1 FROM files WHERE path = reminder_source_state.file_path)`)
      .bind(REMINDER_CACHE_PARSER_VERSION, SCAN_BATCH_SIZE),
    db.prepare(`INSERT INTO reminder_source_state (file_path, file_revision, parser_version, verified)
      SELECT path, storage_key, 0, 0 FROM files WHERE path IN (SELECT value FROM json_each(?))
      ON CONFLICT(file_path) DO UPDATE SET file_revision = excluded.file_revision,
        parser_version = 0, verified = 0, updated_at = datetime('now')
      WHERE reminder_source_state.file_revision != excluded.file_revision`).bind(JSON.stringify(files.map(file => file.path))),
    db.prepare(`INSERT INTO maintenance_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).bind(SCAN_KEY, next),
  ]);
  return next !== '';
}

/** At most limit files and 2 MiB of R2 content per invocation; durable rows resume across restarts. */
export async function revalidateReminderSources(env: Env, limit: number): Promise<boolean> {
  const scanning = await seedSourceStates(env.DB);
  const count = Math.max(1, Math.min(limit, 4));
  const sources = await queryRows<StoredMarkdownFileMetadata>(env.DB.prepare(`SELECT f.path, f.hash, f.size, f.storage_key AS storageKey
    FROM (SELECT file_path FROM reminder_source_state WHERE parser_version < ? ORDER BY parser_version, file_path LIMIT ?) s
    JOIN files f ON f.path = s.file_path`).bind(REMINDER_CACHE_PARSER_VERSION, count));
  if (sources.length < count) sources.push(...await queryRows<StoredMarkdownFileMetadata>(env.DB.prepare(`SELECT f.path, f.hash, f.size, f.storage_key AS storageKey
    FROM (SELECT file_path FROM reminder_source_state INDEXED BY reminder_source_state_retry_idx
      WHERE verified = 0 AND parser_version = ? AND updated_at < datetime('now', '-1 hour') ORDER BY updated_at, file_path LIMIT ?) s
    JOIN files f ON f.path = s.file_path`).bind(REMINDER_CACHE_PARSER_VERSION, count - sources.length)));
  let bytes = 0;
  for (const file of sources) {
    const readableBytes = file.size <= REMINDER_INDEX_MAX_FILE_BYTES ? file.size : 0;
    if (bytes + readableBytes > MAX_REPARSE_BYTES) break;
    bytes += readableBytes;
    try {
      if (file.size > REMINDER_INDEX_MAX_FILE_BYTES) throw new Error(REMINDER_SOURCE_SIZE_ISSUE);
      const [text] = await readStoredMarkdownFiles(env.BUCKET, [file]);
      if (!text) throw new Error('Committed reminder content could not be verified');
      await env.DB.batch(enqueueFileProjection(env.DB, file.path, file.storageKey, text.content));
    } catch (error) {
      const issue = error instanceof Error ? error.message.slice(0, 512) : 'Committed reminder content could not be verified';
      await env.DB.batch([
        recordReminderSourceState(env.DB, file.path, file.storageKey, false),
        env.DB.prepare(`INSERT INTO notification_projection_jobs (path, job_token, last_error)
          SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM files WHERE path = ? AND storage_key = ?)
          ON CONFLICT(path) DO UPDATE SET job_token = excluded.job_token, last_error = excluded.last_error, updated_at = datetime('now')`)
          .bind(file.path, crypto.randomUUID(), issue, file.path, file.storageKey),
      ]);
    }
  }
  return scanning || Boolean(await env.DB.prepare('SELECT 1 FROM reminder_source_state WHERE parser_version < ? LIMIT 1')
    .bind(REMINDER_CACHE_PARSER_VERSION).first());
}
