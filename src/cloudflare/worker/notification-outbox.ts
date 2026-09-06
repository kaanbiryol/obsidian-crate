import { queryRows } from './db';
import { cancelScheduledReminder, scheduleScheduledReminder } from './reminder-handlers';
import type { Env } from './types';

interface SchedulePayload {
	reminderId: string;
	content: string;
	project?: string | null;
	dueDatetime: string;
	priority?: number;
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
	if (job.operation === 'cancel') {
		await cancelScheduledReminder(env, job.reminder_id, job.job_token);
		return;
	}

	if (!job.payload_json) throw new Error('Notification schedule payload is missing');
	const payload = JSON.parse(job.payload_json) as SchedulePayload;
	if (payload.reminderId !== job.reminder_id) throw new Error('Notification schedule payload is invalid');
	await scheduleScheduledReminder(env, { ...payload, jobToken: job.job_token });
}

async function processNotificationJob(
	env: Env,
	reminderId: string,
	jobToken?: string,
): Promise<string | undefined> {
	const job = await env.DB.prepare(`SELECT reminder_id, job_token, operation, payload_json, attempts
		FROM notification_jobs WHERE reminder_id = ?`)
		.bind(reminderId)
		.first<NotificationJobRow>();
	if (!job || (jobToken && job.job_token !== jobToken)) return undefined;

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
