import { featureEnabled } from '../feature-policy';
import { queryRows } from '../db';
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

const OUTBOX_BATCH_SIZE = 10;
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

async function processNotificationJob(env: Env, job: NotificationJobRow): Promise<string | undefined> {
	// Each reminder object rejects a superseded job token, and every write below
	// is token-guarded, so the batch row needs no second read.
	try {
		await runJob(env, job);
		await env.DB.prepare('DELETE FROM notification_jobs WHERE reminder_id = ? AND job_token = ?')
			.bind(job.reminder_id, job.job_token)
			.run();
		return undefined;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await env.DB.prepare(`UPDATE notification_jobs SET
			attempts = attempts + 1,
			available_at = ?,
			last_error = ?,
			updated_at = datetime('now')
			WHERE reminder_id = ? AND job_token = ?`)
			.bind(job.attempts + 1 >= 8 ? -1 : Date.now() + retryDelayMs(job.attempts), message.slice(0, 1024), job.reminder_id, job.job_token)
			.run();
		return message;
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
	// bounds outgoing requests while avoiding serial network round trips.
	for (let offset = 0; offset < jobs.length; offset += 5) {
		const results = await Promise.allSettled(jobs.slice(offset, offset + 5).map(job =>
			processNotificationJob(env, job)));
		const failed = results.find(result => result.status === 'rejected');
		if (failed?.status === 'rejected') throw failed.reason;
	}
}
