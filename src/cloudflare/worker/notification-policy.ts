import type { NotificationPolicy } from '../../protocol/notification-policy';
import { changedRows } from './db';
import { corsResponse } from './cors';
import { parseJsonObject } from './utils';
import { parseFolderPath } from './reminders-web/requests';

export async function getNotificationPolicy(db: D1Database): Promise<NotificationPolicy | null> {
  const row = await db.prepare('SELECT enabled, folder_path, timezone, all_day_time, revision FROM notification_policy WHERE id = 1')
    .first<{ enabled: number; folder_path: string; timezone: string; all_day_time: string | null; revision: string }>();
  return row ? { enabled: row.enabled !== 0, folderPath: row.folder_path, timezone: row.timezone, allDayTime: row.all_day_time, revision: row.revision } : null;
}

export async function handleNotificationPolicy(request: Request, db: D1Database): Promise<Response> {
  if (request.method === 'GET') return corsResponse({ policy: await getNotificationPolicy(db) });
  const parsed = await parseJsonObject(request);
  if (!parsed.ok) return parsed.response;
  const { timezone, allDayTime, expectedRevision, enabled = true } = parsed.value;
  const folder = parseFolderPath(parsed.value.folderPath);
  if (typeof enabled !== 'boolean' || !folder || typeof timezone !== 'string' || !(allDayTime === null || typeof allDayTime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(allDayTime))) {
    return corsResponse({ error: 'Valid folderPath, timezone and allDayTime required' }, 400);
  }
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { return corsResponse({ error: 'Invalid timezone' }, 400); }
  const revision = crypto.randomUUID();
  const mutation = request.method === 'POST'
    ? db.prepare('INSERT INTO notification_policy (id, folder_path, timezone, all_day_time, revision, enabled) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING').bind(folder, timezone, allDayTime, revision, enabled ? 1 : 0)
    : db.prepare('UPDATE notification_policy SET folder_path = ?, timezone = ?, all_day_time = ?, revision = ?, enabled = ? WHERE id = 1 AND revision = ?').bind(folder, timezone, allDayTime, revision, enabled ? 1 : 0, typeof expectedRevision === 'string' ? expectedRevision : '');
  const results = await db.batch([mutation,
    // Schedules from older builds have no verified source mapping. Replace them
    // through projection instead of allowing client snapshots to deliver.
    db.prepare(`INSERT INTO notification_jobs (reminder_id, job_token, operation, payload_json, attempts, available_at)
      SELECT reminder_id, ?, 'cancel', NULL, 0, 0 FROM scheduled_reminders s
      WHERE NOT EXISTS (SELECT 1 FROM reminder_projections p WHERE p.reminder_id = s.reminder_id)
      AND EXISTS (SELECT 1 FROM notification_policy WHERE revision = ?)
      ON CONFLICT(reminder_id) DO UPDATE SET job_token = excluded.job_token, operation = 'cancel', payload_json = NULL, available_at = 0, attempts = 0, last_error = NULL`).bind(revision, revision),
    db.prepare(`INSERT INTO notification_projection_jobs (path, job_token)
      SELECT path, ? FROM files WHERE lower(path) LIKE '%.md' AND EXISTS (SELECT 1 FROM notification_policy WHERE revision = ?)
      ON CONFLICT(path) DO UPDATE SET job_token = excluded.job_token, last_error = NULL`).bind(revision, revision),
    db.prepare(`INSERT INTO notification_projection_jobs (path, job_token)
      SELECT DISTINCT file_path, ? FROM reminder_projections WHERE EXISTS (SELECT 1 FROM notification_policy WHERE revision = ?)
      ON CONFLICT(path) DO UPDATE SET job_token = excluded.job_token, last_error = NULL`).bind(revision, revision),
  ]);
  if (request.method === 'PUT' && changedRows(results[0]) !== 1) return corsResponse({ error: 'Notification settings changed on another device. Refresh before saving.' }, 409);
  return corsResponse({ policy: await getNotificationPolicy(db) });
}
