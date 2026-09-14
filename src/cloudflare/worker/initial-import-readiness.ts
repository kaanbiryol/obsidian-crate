import { corsResponse } from './cors';
import { parseJsonObject } from './utils';
import { REMINDER_CACHE_PARSER_VERSION } from './reminders-web/reminder-cache/types';

export const INITIAL_REMINDERS_PENDING = 'initial_import_reminders_pending';

// Every probe uses primary keys or bounded index lookups, never a full vault scan.
const READY_SQL = `NOT EXISTS (SELECT 1 FROM notification_policy) OR (
  EXISTS (SELECT 1 FROM notification_policy p JOIN maintenance_state m
    ON m.key = 'reminder_source_scan_portable_v${REMINDER_CACHE_PARSER_VERSION}:' || p.folder_path AND m.value = '')
  AND NOT EXISTS (SELECT 1 FROM reminder_source_state WHERE parser_version < ${REMINDER_CACHE_PARSER_VERSION} LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM reminder_source_state WHERE verified = 0 LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM notification_projection_jobs LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM notification_jobs LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM notification_file_retries LIMIT 1)
)`;

/** Acknowledge readiness atomically. Repeated probes write nothing while work remains. */
export async function finishInitialReminderSetup(request: Request, db: D1Database): Promise<Response> {
  const parsed = await parseJsonObject(request);
  if (!parsed.ok) return parsed.response;
  const current = await db.prepare('SELECT token, state FROM initial_import WHERE id = 1').first<{ token: string; state: string }>();
  if (!current || current.token !== parsed.value.token || current.state !== 'complete') {
    return corsResponse({ error: 'Initial upload is not complete' }, 409);
  }
  const result = await db.batch<{ results: Array<{ ready: number; error: string | null }> }>([
    db.prepare(`DELETE FROM maintenance_state WHERE key = ? AND value = ? AND (${READY_SQL})`)
      .bind(INITIAL_REMINDERS_PENDING, current.token),
    db.prepare(`SELECT NOT EXISTS(SELECT 1 FROM maintenance_state WHERE key = ? AND value = ?) AS ready,
      COALESCE((SELECT error FROM notification_file_retries LIMIT 1),
        (SELECT last_error FROM notification_jobs ORDER BY available_at LIMIT 1)) AS error`)
      .bind(INITIAL_REMINDERS_PENDING, current.token),
  ]);
  const status = result[1]!.results[0]!;
  return corsResponse({ ready: Boolean(status.ready), ...(!status.ready && status.error ? { error: status.error } : {}) });
}
