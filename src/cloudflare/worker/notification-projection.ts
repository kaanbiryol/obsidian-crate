import { parseDateTime, toZoned } from '@internationalized/date';
import { queryRows } from './db';
import { getStoredFileRow } from './sync-storage';
import { readStoredMarkdownFiles } from './storage';
import { getNotificationPolicy } from './notification-policy';
import { scanReminderMarkdownFile } from './reminders-web/scan';
import { REMINDER_INDEX_MAX_FILE_BYTES } from './reminders-web/reminder-cache';
import type { Env } from './types';
import type { RemoteReminderRecord } from './reminders-web/types';
import type { NotificationPolicy } from '../../protocol/notification-policy';

export function notificationDatetime(reminder: Pick<RemoteReminderRecord, 'dueDate' | 'dueDatetime'>, policy: NotificationPolicy): string | undefined {
  if (reminder.dueDatetime) return reminder.dueDatetime;
  if (!reminder.dueDate || !policy.allDayTime) return undefined;
  return toZoned(parseDateTime(`${reminder.dueDate}T${policy.allDayTime}`), policy.timezone).toDate().toISOString();
}

/** Bounded projection of committed files. Client reminder snapshots never schedule or cancel. */
export async function drainNotificationProjections(env: Env, limit = 4): Promise<void> {
  const policy = await getNotificationPolicy(env.DB);
  if (!policy) return;
  const jobs = await queryRows<{ path: string; job_token: string }>(env.DB.prepare(
    `SELECT path, job_token FROM notification_projection_jobs WHERE last_error IS NULL OR updated_at < datetime('now', '-1 hour') ORDER BY updated_at, path LIMIT ?`).bind(limit));
  for (const job of jobs) {
    try {
      const file = await getStoredFileRow(env.DB, job.path);
      let reminders: RemoteReminderRecord[] = [];
      if (file && job.path.startsWith(`${policy.folderPath}/`)) {
        if (file.size > REMINDER_INDEX_MAX_FILE_BYTES) throw new Error('Split reminder notes larger than 1 MiB to schedule their notifications');
        const [text] = await readStoredMarkdownFiles(env.BUCKET, [{ path: job.path, ...file }]);
        if (!text) throw new Error('Committed reminder content could not be verified');
        reminders = scanReminderMarkdownFile(job.path, text.content, policy.folderPath);
      }
      const prior = await queryRows<{ reminder_id: string; due_datetime: string }>(env.DB.prepare(
        'SELECT reminder_id, due_datetime FROM scheduled_reminders WHERE reminder_id IN (SELECT reminder_id FROM reminder_projections WHERE file_path = ?)').bind(job.path));
      const scheduled = new Map(prior.map(row => [row.reminder_id, row.due_datetime]));
      const ids = new Set<string>();
      const operations = reminders.map(reminder => {
        if (ids.has(reminder.id)) throw new Error('Duplicate reminder identity in committed file');
        ids.add(reminder.id);
        const dueDatetime = notificationDatetime(reminder, policy);
        const schedule = policy.enabled !== false && !reminder.completed && dueDatetime && (Date.parse(dueDatetime) > Date.now()
          || scheduled.get(reminder.id) === dueDatetime && Date.parse(dueDatetime) > Date.now() - 86_400_000);
        return { id: reminder.id, operation: schedule ? 'schedule' : 'cancel', payload: schedule ? {
          reminderId: reminder.id, content: reminder.content, project: reminder.project, dueDatetime, priority: reminder.priority,
        } : null };
      });
      const json = JSON.stringify(operations);
      if (new TextEncoder().encode(json).byteLength > 1536 * 1024) throw new Error('Split this reminder note into smaller files to schedule notifications');
      const guard = `EXISTS (SELECT 1 FROM notification_projection_jobs WHERE path = ? AND job_token = ?)
        AND EXISTS (SELECT 1 FROM notification_policy WHERE revision = ?)
        AND ${file ? 'EXISTS (SELECT 1 FROM files WHERE path = ? AND storage_key = ?)' : 'NOT EXISTS (SELECT 1 FROM files WHERE path = ?)'} `;
      const args = [job.path, job.job_token, policy.revision, job.path, ...(file ? [file.storageKey] : [])];
      const token = crypto.randomUUID();
      const upsertJob = `ON CONFLICT(reminder_id) DO UPDATE SET job_token = excluded.job_token,
        operation = excluded.operation, payload_json = excluded.payload_json, attempts = 0, available_at = 0, last_error = NULL, updated_at = datetime('now')`;
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO notification_jobs (reminder_id, job_token, operation, payload_json, attempts, available_at)
          SELECT reminder_id, ?, 'cancel', NULL, 0, 0 FROM reminder_projections WHERE file_path = ?
          AND reminder_id NOT IN (SELECT json_extract(value, '$.id') FROM json_each(?)) AND ${guard} ${upsertJob}`)
          .bind(token, job.path, json, ...args),
        env.DB.prepare(`INSERT INTO notification_jobs (reminder_id, job_token, operation, payload_json, attempts, available_at)
          SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.operation'), json_extract(value, '$.payload'), 0, 0
          FROM json_each(?) WHERE ${guard} ${upsertJob}`).bind(token, json, ...args),
        env.DB.prepare(`DELETE FROM reminder_projections WHERE file_path = ? AND ${guard}`).bind(job.path, ...args),
        env.DB.prepare(`INSERT INTO reminder_projections (reminder_id, file_path, file_revision)
          SELECT json_extract(value, '$.id'), ?, ? FROM json_each(?) WHERE ${guard}
          ON CONFLICT(reminder_id) DO UPDATE SET file_path = excluded.file_path, file_revision = excluded.file_revision`)
          .bind(job.path, file?.storageKey ?? '', json, ...args),
        env.DB.prepare(`DELETE FROM notification_projection_jobs WHERE path = ? AND ${guard}`).bind(job.path, ...args),
      ]);
    } catch (error) {
      await env.DB.prepare("UPDATE notification_projection_jobs SET last_error = ?, updated_at = datetime('now') WHERE path = ? AND job_token = ?")
        .bind(error instanceof Error ? error.message.slice(0, 512) : 'Projection failed', job.path, job.job_token).run();
    }
  }
}
