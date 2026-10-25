import { validateReadingFolder } from '@/reading/settings';
import { FILE_FOLDER_MATCH, fileFolderArgs } from '../sync/file-identity';
import type { NotificationPolicy } from '../../../protocol/notification-policy';
import { changedRows } from '../db';
import { corsResponse } from '../cors';
import { parseJsonObject } from '../request-validation';
import { parseFolderPath } from '../reminders/requests';
import { readEncryptionState } from '../encryption/state';
import { folderLabelIssue, readFolderLabel, saveFolderLabel } from '../encryption/folder-labels';

const FOLDER_SCOPED_TABLES = ['auth_tokens', 'push_subscriptions', 'web_enrollment_tokens'] as const;

export async function getNotificationPolicy(db: D1Database): Promise<NotificationPolicy | null> {
  const row = await db.prepare('SELECT enabled, folder_path, timezone, all_day_time, revision FROM notification_policy WHERE id = 1')
    .first<{ enabled: number; folder_path: string; timezone: string; all_day_time: string | null; revision: string }>();
  return row ? { enabled: row.enabled !== 0, folderPath: row.folder_path, timezone: row.timezone, allDayTime: row.all_day_time, revision: row.revision } : null;
}

/** For clients: an encrypted vault's policy also carries the folder's sealed name. */
async function labelledNotificationPolicy(db: D1Database): Promise<NotificationPolicy | null> {
  const policy = await getNotificationPolicy(db);
  const label = policy && await readEncryptionState(db) ? await readFolderLabel(db, policy.folderPath) : null;
  return policy && label ? { ...policy, folderLabel: label } : policy;
}

export async function handleNotificationPolicy(request: Request, db: D1Database): Promise<Response> {
  if (request.method === 'GET') return corsResponse({ policy: await labelledNotificationPolicy(db) });
  const parsed = await parseJsonObject(request);
  if (!parsed.ok) return parsed.response;
  const { timezone, allDayTime, expectedRevision, enabled = true } = parsed.value;
  const folder = parseFolderPath(parsed.value.folderPath);
  if (typeof enabled !== 'boolean' || !folder || typeof timezone !== 'string' || !(allDayTime === null || typeof allDayTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(allDayTime))) {
    return corsResponse({ error: 'Valid folderPath, timezone and allDayTime required' }, 400);
  }
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { return corsResponse({ error: 'Invalid timezone' }, 400); }
  const encryption = await readEncryptionState(db);
  const labelIssue = folderLabelIssue(encryption, folder, parsed.value.folderLabel);
  if (labelIssue) return corsResponse({ error: labelIssue }, 428);
  const reading = await db.prepare('SELECT folder_path FROM reading_policy WHERE id=1').first<{ folder_path: string }>();
  if (reading) { try { validateReadingFolder(reading.folder_path, folder); } catch { return corsResponse({ error: 'Choose separate Reading and reminders folders.' }, 400); } }
  const revision = crypto.randomUUID();
  const mutation = request.method === 'POST'
    ? db.prepare('INSERT INTO notification_policy (id, folder_path, timezone, all_day_time, revision, enabled) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING').bind(folder, timezone, allDayTime, revision, enabled ? 1 : 0)
    : db.prepare('UPDATE notification_policy SET folder_path = ?, timezone = ?, all_day_time = ?, revision = ?, enabled = ? WHERE id = 1 AND revision = ?').bind(folder, timezone, allDayTime, revision, enabled ? 1 : 0, typeof expectedRevision === 'string' ? expectedRevision : '');
  // Web app sessions, their push subscriptions and unused setup links follow a
  // changed folder. These run first, while the policy still names the old one.
  const follow = request.method === 'PUT' ? FOLDER_SCOPED_TABLES.map(table => db.prepare(`UPDATE ${table} SET folder_path = ?
    WHERE folder_path = (SELECT folder_path FROM notification_policy WHERE id = 1 AND revision = ?) AND folder_path != ?
      ${table === 'auth_tokens' ? "AND scope = 'reminders'" : ''}`).bind(folder, typeof expectedRevision === 'string' ? expectedRevision : '', folder)) : [];
  const results = await db.batch([...follow, mutation,
    ...(encryption ? [saveFolderLabel(db, folder, parsed.value.folderLabel as string)] : []),
    db.prepare('DELETE FROM notification_file_retries WHERE EXISTS (SELECT 1 FROM notification_policy WHERE revision = ?)').bind(revision),
    db.prepare(`INSERT INTO notification_projection_jobs (path, job_token)
      SELECT path, ? FROM files WHERE ${FILE_FOLDER_MATCH} AND lower(path) LIKE '%.md'
        AND EXISTS (SELECT 1 FROM notification_policy WHERE revision = ?)
      ON CONFLICT(path) DO UPDATE SET job_token = excluded.job_token, last_error = NULL`).bind(revision, ...fileFolderArgs(folder), revision),
    db.prepare(`DELETE FROM maintenance_state WHERE key LIKE 'reminder_source_scan_%'
      AND EXISTS (SELECT 1 FROM notification_policy WHERE revision = ?)`).bind(revision),
    db.prepare(`INSERT INTO notification_projection_jobs (path, job_token)
      SELECT DISTINCT file_path, ? FROM reminder_projections WHERE EXISTS (SELECT 1 FROM notification_policy WHERE revision = ?)
      ON CONFLICT(path) DO UPDATE SET job_token = excluded.job_token, last_error = NULL`).bind(revision, revision),
  ]);
  if (request.method === 'PUT' && changedRows(results[follow.length]) !== 1) return corsResponse({ error: 'Notification settings changed on another device. Refresh before saving.' }, 409);
  return corsResponse({ policy: await labelledNotificationPolicy(db) });
}
