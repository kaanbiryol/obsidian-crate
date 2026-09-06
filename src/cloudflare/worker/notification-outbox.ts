import { queryRows } from './db';
import type { Env } from './types';

interface SchedulePayload {
	reminderId: string;
	content: string;
	project?: string | null;
	dueDatetime: string;
}

interface NotificationJobRow {
	reminder_id: string;
	job_token: string;
	operation: 'schedule' | 'cancel';
	payload_json: string | null;
	attempts: number;
}

const OUTBOX_BATCH_SIZE = 5;
const OUTBOX_MAX_DELAY_MS = 6 * 60 * 60 * 1000;

function retryDelayMs(attempt: number): number {
	return Math.min(60_000 * (2 ** Math.min(attempt, 8)), OUTBOX_MAX_DELAY_MS);
}

async function runJob(env: Env, job: NotificationJobRow): Promise<void> {
	const alarm = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName(job.reminder_id));
	if (job.operation === 'cancel') {
		const response = await alarm.fetch(`https://do/cancel?reminderId=${encodeURIComponent(job.reminder_id)}&jobToken=${encodeURIComponent(job.job_token)}`, { method: 'DELETE' });
		if (!response.ok) throw new Error('Failed to cancel alarm');
		return;
	}
	if (!job.payload_json) throw new Error('Notification schedule payload is missing');
	const payload = JSON.parse(job.payload_json) as SchedulePayload;
	if (payload.reminderId !== job.reminder_id || !Number.isFinite(Date.parse(payload.dueDatetime))) throw new Error('Notification schedule payload is invalid');
	const response = await alarm.fetch('https://do/schedule', {
		method: 'PUT', body: JSON.stringify({ ...payload, jobToken: job.job_token }),
	});
	if (!response.ok) throw new Error('Failed to schedule alarm');
}

async function processNotificationJob(
	env: Env,
	reminderId: string,
	jobToken: string,
): Promise<string | undefined> {
	const job = await env.DB.prepare(`SELECT reminder_id, job_token, operation, payload_json, attempts
		FROM notification_jobs WHERE reminder_id = ?`)
		.bind(reminderId)
		.first<NotificationJobRow>();
	if (!job || job.job_token !== jobToken) return undefined;

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
			.bind(Date.now() + retryDelayMs(job.attempts), message.slice(0, 1024), job.reminder_id, job.job_token)
			.run();
		return message;
	}
}

export async function drainNotificationJobs(env: Env, limit = OUTBOX_BATCH_SIZE): Promise<void> {
	const jobs = await queryRows<Pick<NotificationJobRow, 'reminder_id' | 'job_token'>>(
		env.DB.prepare(`SELECT reminder_id, job_token FROM notification_jobs
			WHERE available_at <= ? ORDER BY available_at ASC LIMIT ?`)
			.bind(Date.now(), limit),
	);
	for (const job of jobs) {
		await processNotificationJob(env, job.reminder_id, job.job_token);
	}
}
