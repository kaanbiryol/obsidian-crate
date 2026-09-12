import { corsResponse } from './cors';
import { queryRows } from './db';

/** Explicit user action; bounded, and never called by the processing loop. */
export async function retryPausedNotifications(db: D1Database): Promise<Response> {
  const files = await queryRows<{ path: string }>(db.prepare(
    'SELECT path FROM notification_file_retries WHERE (attempts >= 8 OR available_at < 0) ORDER BY path LIMIT 101'));
  const jobs = await queryRows<{ reminder_id: string }>(db.prepare(
    'SELECT reminder_id FROM notification_jobs WHERE available_at < 0 ORDER BY reminder_id LIMIT 101'));
  const paths = JSON.stringify(files.slice(0, 100).map(row => row.path));
  const ids = JSON.stringify(jobs.slice(0, 100).map(row => row.reminder_id));
  await db.batch([
    db.prepare(`UPDATE notification_file_retries SET attempts = 0, available_at = 0
      WHERE path IN (SELECT value FROM json_each(?))`).bind(paths),
    db.prepare(`UPDATE notification_jobs SET attempts = 0, available_at = 0, last_error = NULL
      WHERE reminder_id IN (SELECT value FROM json_each(?))`).bind(ids),
  ]);
  return corsResponse({ retried: Math.min(files.length, 100) + Math.min(jobs.length, 100), more: files.length > 100 || jobs.length > 100 });
}
