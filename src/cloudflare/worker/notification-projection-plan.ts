import { queryRows } from './db';

interface SchedulePayload {
  reminderId: string;
  content: string;
  project?: string | null;
  dueDatetime: string;
}
export type NotificationOperation =
  | { id: string; operation: 'schedule'; payload: SchedulePayload }
  | { id: string; operation: 'cancel'; payload: null };
interface ExistingNotification {
  id: string;
  token: string | null;
  jobToken: string | null;
  operation: string | null;
  payload: string | null;
  scheduleToken: string | null;
  content: string | null;
  project: string | null;
  dueDatetime: string | null;
}

function samePayload(left: SchedulePayload | null, right: SchedulePayload): boolean {
  return left?.reminderId === right.reminderId && left.content === right.content
    && (left.project || null) === (right.project || null) && left.dueDatetime === right.dueDatetime;
}

function canReuse(row: ExistingNotification, operation: NotificationOperation): boolean {
  if (row.jobToken !== null) {
    if (!row.token || row.token !== row.jobToken || row.operation !== operation.operation) return false;
    if (operation.operation === 'cancel') return true;
    try { return samePayload(JSON.parse(row.payload ?? 'null') as SchedulePayload | null, operation.payload); }
    catch { return false; }
  }
  if (operation.operation === 'cancel') return row.scheduleToken === null;
  return Boolean(row.token && row.token === row.scheduleToken && operation.payload
    && samePayload({ reminderId: row.id, content: row.content!, project: row.project, dueDatetime: row.dueDatetime! }, operation.payload));
}

/** Preserve command tokens and retry state when the effective alarm is unchanged.
 * File and policy authority still advance atomically in the projection commit.
 * Missing or mismatched schedule state takes the ordinary repair path.
 */
export async function planNotificationOperations(db: D1Database, operations: NotificationOperation[], token: string) {
  const rows = await queryRows<ExistingNotification>(db.prepare(`SELECT ids.value AS id,
    p.notification_token AS token, j.job_token AS jobToken, j.operation, j.payload_json AS payload,
    s.schedule_token AS scheduleToken, s.content, s.project, s.due_datetime AS dueDatetime
    FROM json_each(?) ids
    LEFT JOIN reminder_projections p ON p.reminder_id = ids.value
    LEFT JOIN notification_jobs j ON j.reminder_id = ids.value
    LEFT JOIN scheduled_reminders s ON s.reminder_id = ids.value`)
    .bind(JSON.stringify(operations.map(operation => operation.id))));
  const existing = new Map(rows.map(row => [row.id, row]));
  return operations.map(operation => {
    const row = existing.get(operation.id);
    const reuse = row && canReuse(row, operation);
    return { ...operation, token: reuse ? row.token ?? token : token, enqueue: !reuse };
  });
}
