import { REMINDER_CACHE_PARSER_VERSION } from './reminders-web/reminder-cache/types';

/** This durable authority is separate from the disposable, folder-specific UI cache. */
export function recordReminderSourceState(db: D1Database, path: string, storageKey: string | null, verified: boolean): D1PreparedStatement {
  if (storageKey === null) return db.prepare(`DELETE FROM reminder_source_state WHERE file_path = ?
    AND NOT EXISTS (SELECT 1 FROM files WHERE path = ?)`).bind(path, path);
  return db.prepare(`INSERT INTO reminder_source_state (file_path, file_revision, parser_version, verified)
    SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM files WHERE path = ? AND storage_key = ?)
    ON CONFLICT(file_path) DO UPDATE SET file_revision = excluded.file_revision,
      parser_version = excluded.parser_version, verified = excluded.verified, updated_at = datetime('now')`)
    .bind(path, storageKey, REMINDER_CACHE_PARSER_VERSION, verified ? 1 : 0, path, storageKey);
}

export async function hasVerifiedReminderSource(db: D1Database, path: string, storageKey: string): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT 1 FROM reminder_source_state WHERE file_path = ?
    AND file_revision = ? AND parser_version = ? AND verified = 1`)
    .bind(path, storageKey, REMINDER_CACHE_PARSER_VERSION).first());
}

/** Queued commands and existing alarms both need current source and projection authority. */
export async function hasNotificationAuthority(db: D1Database, reminderId: string, token: string): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT 1 FROM reminder_projections p
    JOIN files f ON f.path = p.file_path AND f.storage_key = p.file_revision
    JOIN reminder_source_state source ON source.file_path = p.file_path AND source.file_revision = f.storage_key
    JOIN notification_policy policy ON policy.id = 1 AND policy.revision = p.policy_revision AND policy.enabled = 1
    WHERE p.reminder_id = ? AND p.notification_token = ? AND source.parser_version = ? AND source.verified = 1
      AND NOT EXISTS (SELECT 1 FROM notification_projection_jobs WHERE path = p.file_path)`)
    .bind(reminderId, token, REMINDER_CACHE_PARSER_VERSION).first());
}
