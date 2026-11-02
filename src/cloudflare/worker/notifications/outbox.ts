import { featureEnabled } from '../server/feature-policy';
import { queryRows } from '../d1/db';
import type { Env } from '../types';
import { cancelReminderDelivery, dispatchNotifications, scheduleReminderDelivery } from '../coordinator/coordinator';

interface SchedulePayload {
	reminderId: string;
	content: string;
	project?: string | null;
	dueDatetime: string;
	resume?: boolean;
}

interface NotificationJobRow {
	reminder_id: string;
	job_token: string;
	operation: 'schedule' | 'cancel';
	payload_json: string | null;
	attempts: number;
}

// One read plus one acknowledgement batch per group of five jobs stays within
// D1_QUERIES_PER_INVOCATION.
export const OUTBOX_BATCH_SIZE = 200;
const OUTBOX_MAX_DELAY_MS = 6 * 60 * 60 * 1000;

/** The existing class supplies a separate request budget; no extra persistent state. */
export async function dispatchNotificationJobs(env: Env, remindersEnabled?: boolean): Promise<void> {
	if (!await dispatchNotifications(env, remindersEnabled)) throw new Error('Unable to process reminder schedules');
}

/** Makes queued cancellations due and drains a bounded batch of them. A lost reply
 * is harmless: cancellation is token-checked and removes its private DO state.
 * Drains even while Reminders is paused: the reset turned every job into a cancel.
 * Returns whether any job or installed schedule remains. */
export async function drainNotificationCancellations(env: Env): Promise<boolean> {
	await env.DB.prepare("UPDATE notification_jobs SET available_at = 0 WHERE operation = 'cancel' AND available_at != 0").run();
	await dispatchNotificationJobs(env, true);
	return Boolean(await env.DB.prepare('SELECT 1 FROM notification_jobs UNION SELECT 1 FROM scheduled_reminders LIMIT 1').first());
}

function retryDelayMs(attempt: number): number {
	return Math.min(60_000 * (2 ** Math.min(attempt, 8)), OUTBOX_MAX_DELAY_MS);
}

async function runJob(env: Env, job: NotificationJobRow): Promise<void> {
	if (job.operation === 'cancel') {
		const response = await cancelReminderDelivery(env, job.reminder_id, job.job_token);
		if (!response.ok) throw new Error('Failed to cancel alarm');
		return;
	}
	if (!job.payload_json) throw new Error('Notification schedule payload is missing');
	const payload = JSON.parse(job.payload_json) as SchedulePayload;
	if (payload.reminderId !== job.reminder_id || !Number.isFinite(Date.parse(payload.dueDatetime))) throw new Error('Notification schedule payload is invalid');
	const response = await scheduleReminderDelivery(env, job.reminder_id, { ...payload, jobToken: job.job_token });
	if (!response.ok) throw new Error('Failed to schedule alarm');
}

/** Runs one job and returns the statement that acknowledges its outcome. */
async function runNotificationJob(env: Env, job: NotificationJobRow): Promise<D1PreparedStatement> {
	// Each reminder object rejects a superseded job token, and every write below
	// is token-guarded, so the batch row needs no second read.
	try {
		await runJob(env, job);
		return env.DB.prepare('DELETE FROM notification_jobs WHERE reminder_id = ? AND job_token = ?')
			.bind(job.reminder_id, job.job_token);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return env.DB.prepare(`UPDATE notification_jobs SET
			attempts = attempts + 1,
			available_at = ?,
			last_error = ?,
			updated_at = datetime('now')
			WHERE reminder_id = ? AND job_token = ?`)
			.bind(job.attempts + 1 >= 8 ? -1 : Date.now() + retryDelayMs(job.attempts), message.slice(0, 1024), job.reminder_id, job.job_token);
	}
}

export async function drainNotificationJobs(env: Env, limit = OUTBOX_BATCH_SIZE, remindersEnabled?: boolean): Promise<void> {
	if (!(remindersEnabled ?? await featureEnabled(env.DB, 'reminders'))) return;
	const jobs = await queryRows<NotificationJobRow>(
		env.DB.prepare(`SELECT reminder_id, job_token, operation, payload_json, attempts FROM notification_jobs
			WHERE available_at >= 0 AND available_at <= ? ORDER BY available_at ASC LIMIT ?`)
			.bind(Date.now(), limit),
	);
	// Distinct reminder IDs have independent Durable Object locks. Five at a time
	// bounds outgoing requests while avoiding serial network round trips, and one
	// batch acknowledges each group. A lost acknowledgement only reruns its jobs,
	// which their reminder objects accept or reject by token.
	for (let offset = 0; offset < jobs.length; offset += 5) {
		await env.DB.batch(await Promise.all(jobs.slice(offset, offset + 5).map(job => runNotificationJob(env, job))));
	}
}

/** Wakes dormant alarms when reminders turn back on, without replacing occurrence
 * identity or recipient progress. The caller runs it in its own batch. */
export function resumeScheduledReminderJobs(db: D1Database): D1PreparedStatement {
	return db.prepare(`INSERT INTO notification_jobs(reminder_id,job_token,operation,payload_json,available_at)
      SELECT reminder_id,schedule_token,'schedule',json_object('reminderId',reminder_id,'content',content,'project',project,'dueDatetime',due_datetime,'resume',json('true')),0
      FROM scheduled_reminders WHERE delivery_failed_at IS NULL
      ON CONFLICT(reminder_id) DO NOTHING`);
}

/** Turns every scheduled reminder and queued job into an immediate cancellation, as
 * when the vault's devices are reset. The caller runs them in its own batch. */
export function cancelAllNotificationJobs(db: D1Database): D1PreparedStatement[] {
	return [
		db.prepare(`INSERT INTO notification_jobs(reminder_id, job_token, operation, available_at)
			SELECT reminder_id, lower(hex(randomblob(16))), 'cancel', 0 FROM scheduled_reminders WHERE 1
			ON CONFLICT(reminder_id) DO UPDATE SET operation = 'cancel', job_token = excluded.job_token, payload_json = NULL, available_at = 0`),
		db.prepare("UPDATE notification_jobs SET operation = 'cancel', payload_json = NULL, available_at = 0"),
	];
}
