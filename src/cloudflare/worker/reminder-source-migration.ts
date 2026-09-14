import { portablePathKey } from '../../protocol/portable-path';
import { FILE_FOLDER_MATCH, FILE_PATH_MATCH, fileFolderArgs, filePathArgs } from './file-identity';
import { loadStoredFileRows } from './sync-storage';
import { recordFileFailure } from './notification-file-retries';
import { queryRows } from './db';
import { enqueueFileProjection } from './notification-projection-queue';
import { recordReminderSourceState } from './reminder-source-state';
import { readStoredMarkdownFiles } from './storage';
import { REMINDER_SOURCE_SIZE_ISSUE, PermanentReminderSourceError, isPermanentSourceError } from './reminder-source-parse';
import { REMINDER_CACHE_PARSER_VERSION, REMINDER_INDEX_MAX_FILE_BYTES } from './reminders-web/reminder-cache/types';
import type { Env } from './types';
import { getReminderFolder } from './reminder-scope';
import { retireOutOfScopeSources } from './reminder-scope-cleanup';

const SCAN_KEY = `reminder_source_scan_portable_v${REMINDER_CACHE_PARSER_VERSION}`;
const SCAN_BATCH_SIZE = 100;
const MAX_REPARSE_BYTES = 2 * 1024 * 1024;

/** One resumable pass per parser version. Normal file commits record their own source state. */
async function seedSourceStates(db: D1Database, folder: string): Promise<boolean> {
  const scanKey = `${SCAN_KEY}:${folder}`;
  const saved = await db.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(scanKey).first<{ value: string }>();
  // An empty saved cursor marks completion; a missing row starts the migration.
  if (saved?.value === '') return false;
  const cursor = saved?.value ?? '';
  const files = await queryRows<{ path: string }>(db.prepare(`SELECT path FROM files
    WHERE ${FILE_FOLDER_MATCH} AND lower(path) LIKE '%.md' AND portable_path > ? ORDER BY portable_path LIMIT ?`)
    .bind(...fileFolderArgs(folder), portablePathKey(cursor), SCAN_BATCH_SIZE));
  const next = files.length === SCAN_BATCH_SIZE ? files[files.length - 1]!.path : '';
  await db.batch([
    db.prepare(`INSERT INTO reminder_source_state (file_path, file_revision, parser_version, verified)
      SELECT path, storage_key, 0, 0 FROM files WHERE portable_path IN (SELECT value FROM json_each(?))
      ON CONFLICT(file_path) DO UPDATE SET file_revision = excluded.file_revision,
        parser_version = 0, verified = 0, updated_at = datetime('now')
      WHERE reminder_source_state.file_revision != excluded.file_revision`).bind(JSON.stringify(files.map(file => portablePathKey(file.path)))),
    db.prepare(`INSERT INTO maintenance_state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).bind(scanKey, next),
  ]);
  return next !== '';
}

/** At most limit files and 2 MiB of R2 content per invocation; durable rows resume across restarts. */
export async function revalidateReminderSources(env: Env, limit: number, scope?: { folder: string | null }): Promise<boolean> {
  if (!scope && await env.DB.prepare("SELECT 1 FROM initial_import WHERE state = 'importing'").first()) return false;
  const folder = scope ? scope.folder : await getReminderFolder(env.DB);
  const cleaning = await retireOutOfScopeSources(env.DB, folder);
  if (folder === null || cleaning) return cleaning;
  const scanning = await seedSourceStates(env.DB, folder);
  const count = Math.max(1, Math.min(limit, 4));
  const sources = await queryRows<{ path: string }>(env.DB.prepare(`SELECT file_path AS path
    FROM reminder_source_state WHERE parser_version < ? AND file_path >= ? AND file_path < ? ORDER BY parser_version, file_path LIMIT ?`)
    .bind(REMINDER_CACHE_PARSER_VERSION, `${folder}/`, `${folder}0`, count));
  const upgraded = new Set(sources.map(file => file.path));
  if (sources.length < count) sources.push(...await queryRows<{ path: string }>(env.DB.prepare(`SELECT s.file_path AS path
    FROM (SELECT r.path AS file_path FROM (SELECT path, available_at FROM notification_file_retries
        WHERE path >= ? AND path < ? AND available_at >= 0 AND available_at <= unixepoch('now') * 1000
        ORDER BY available_at, path LIMIT ?) r
      JOIN reminder_source_state s ON s.file_path = r.path
      WHERE r.available_at >= 0 AND r.available_at <= unixepoch('now') * 1000
        AND s.verified = 0 AND s.parser_version = ?
      ORDER BY r.available_at, r.path) s`).bind(`${folder}/`, `${folder}0`, count - sources.length, REMINDER_CACHE_PARSER_VERSION)));
  const stored = await loadStoredFileRows(env.DB, sources.map(file => file.path));
  let bytes = 0;
  for (const { path } of sources) {
    const current = stored.get(path);
    if (!current) {
      // Deleted legacy rows must still drain after the one-time scan finishes.
      await env.DB.prepare(`DELETE FROM reminder_source_state WHERE file_path = ?
        AND NOT EXISTS (SELECT 1 FROM files WHERE ${FILE_PATH_MATCH})`).bind(path, ...filePathArgs(path)).run();
      continue;
    }
    const file = { path, ...current };
    if (upgraded.has(file.path)) await env.DB.prepare(`DELETE FROM notification_file_retries WHERE path = ?
      AND EXISTS (SELECT 1 FROM reminder_source_state WHERE file_path = ? AND parser_version < ?)`)
      .bind(file.path, file.path, REMINDER_CACHE_PARSER_VERSION).run();
    const readableBytes = file.size <= REMINDER_INDEX_MAX_FILE_BYTES ? file.size : 0;
    if (bytes + readableBytes > MAX_REPARSE_BYTES) break;
    bytes += readableBytes;
    try {
      if (file.size > REMINDER_INDEX_MAX_FILE_BYTES) throw new PermanentReminderSourceError(REMINDER_SOURCE_SIZE_ISSUE);
      const [text] = await readStoredMarkdownFiles(env.BUCKET, [file]);
      if (!text) throw new Error('Committed reminder content could not be verified');
      await env.DB.batch([
        ...await enqueueFileProjection(env.DB, file.path, file.storageKey, text.content, true),
        env.DB.prepare(`UPDATE notification_file_retries SET available_at = NULL WHERE path = ?
          AND EXISTS (SELECT 1 FROM reminder_source_state WHERE file_path = ? AND file_revision = ? AND verified = 1)`)
          .bind(file.path, file.path, file.storageKey),
      ]);
    } catch (error) {
      const issue = error instanceof Error ? error.message.slice(0, 512) : 'Committed reminder content could not be verified';
      await env.DB.batch([
        recordReminderSourceState(env.DB, file.path, file.storageKey, false),
        recordFileFailure(env.DB, file.path, issue, `EXISTS (SELECT 1 FROM files WHERE ${FILE_PATH_MATCH} AND storage_key = ?)`, [...filePathArgs(file.path), file.storageKey], isPermanentSourceError(error)),
        env.DB.prepare(`INSERT INTO notification_projection_jobs (path, job_token, last_error)
          SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM files WHERE ${FILE_PATH_MATCH} AND storage_key = ?)
          ON CONFLICT(path) DO UPDATE SET job_token = excluded.job_token, last_error = excluded.last_error, updated_at = datetime('now')`)
          .bind(file.path, crypto.randomUUID(), issue, ...filePathArgs(file.path), file.storageKey),
      ]);
    }
  }
  return cleaning || scanning || Boolean(await env.DB.prepare('SELECT 1 FROM reminder_source_state WHERE parser_version < ? AND file_path >= ? AND file_path < ? LIMIT 1')
    .bind(REMINDER_CACHE_PARSER_VERSION, `${folder}/`, `${folder}0`).first());
}
