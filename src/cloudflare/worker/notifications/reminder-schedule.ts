import { featureEnabled } from '../feature-policy';
import { PushPayloadError } from './payload-budget';
import type { Env } from '../types';
import { changedRows } from '../db';
import { parseJsonObject, parseOptionalString } from '../request-validation';
import { listPushSubscriptions, sendToAllSubscriptions, type PushSubscriptionRow } from './push';
import { hasNotificationAuthority } from '../reminders/source-state';
import { NOTIFICATION_DELIVERY_WINDOW_MS } from './projection-plan';

/** The per-reminder role of the `ReminderAlarm` Durable Object: one schedule,
 * its delivery progress and its retry state live in that object's storage. */
export interface ReminderScheduleContext {
	state: DurableObjectState;
	env: Env;
	/** Serializes short storage transitions; deliveries run outside it. */
	withStateLock<T>(action: () => Promise<T>): Promise<T>;
}

/** Durable Object responses are internal; they carry no CORS or cache headers. */
function internalJson(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

interface ReminderData {
	reminderId: string;
	scheduleToken: string;
	content: string;
	project?: string;
	dueDatetime: string;
}

interface ScheduledReminderRow {
	schedule_token: string;
	content: string;
	project: string | null;
	due_datetime: string;
}

interface ReminderAlarmSnapshot {
	reminder: ReminderData | undefined;
	alarmTime: number | null;
	pendingSubscriptionIds: string[] | undefined;
	deliveryComplete: boolean | undefined;
	retryAttempt: number | undefined;
	deliveryFailure: DeliveryFailure | undefined;
}

interface DeliveryFailure { attempts: number; failedAt: string; error: string }

const PENDING_SUBSCRIPTION_IDS_KEY = 'pendingSubscriptionIds';
const DELIVERY_COMPLETE_KEY = 'deliveryComplete';
const RETRY_ATTEMPT_KEY = 'retryAttempt';
const RETRY_BASE_DELAY_MS = 60_000;
const RETRY_MAX_DELAY_MS = 6 * 60 * 60 * 1000;
const MAX_DELIVERY_RETRY_ATTEMPTS = 10;
const MAX_DELIVERY_RETRY_AGE_MS = NOTIFICATION_DELIVERY_WINDOW_MS;
const DELIVERY_FAILURE_KEY = 'deliveryFailure';
const COMPLETED_OCCURRENCE_KEY = 'completedOccurrence';

function retryDelayMs(attempt: number): number {
	return Math.min(RETRY_BASE_DELAY_MS * (2 ** Math.min(attempt, 8)), RETRY_MAX_DELAY_MS);
}

// A new schedule can arrive while a push request is in flight. Every delivery
// write checks its schedule token (or occurrence) under the state lock.
function writeIfCurrent(context: ReminderScheduleContext, token: string, action: () => Promise<unknown>): Promise<boolean> {
	return context.withStateLock(async () => {
		if ((await context.state.storage.get<ReminderData>('reminder'))?.scheduleToken !== token) return false;
		await action();
		return true;
	});
}

function writeIfOccurrenceCurrent(context: ReminderScheduleContext, dueDatetime: string, action: () => Promise<unknown>): Promise<boolean> {
	return context.withStateLock(async () => {
		if ((await context.state.storage.get<ReminderData>('reminder'))?.dueDatetime !== dueDatetime) return false;
		await action();
		return true;
	});
}

/** Schedule (PUT) or cancel (DELETE) this object's reminder for a notification job. */
export async function handleReminderScheduleRequest(request: Request, context: ReminderScheduleContext): Promise<Response> {
	if (request.method === 'PUT') return scheduleReminder(request, context);
	if (request.method === 'DELETE') return cancelReminder(request, context);
	return new Response('Method not allowed', { status: 405 });
}

async function scheduleReminder(request: Request, context: ReminderScheduleContext): Promise<Response> {
	const { state, env } = context;
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) return parsedBody.response;

	const reminderId = parseOptionalString(parsedBody.value.reminderId, 256);
	const content = parseOptionalString(parsedBody.value.content, 4096);
	const dueDatetime = parseOptionalString(parsedBody.value.dueDatetime, 128);
	const project = parsedBody.value.project === undefined
		? undefined
		: parseOptionalString(parsedBody.value.project, 256) || undefined;
	if (!reminderId || !content || !dueDatetime) {
		return internalJson({ error: 'Invalid reminder payload' }, 400);
	}

	const alarmTime = new Date(dueDatetime);
	if (Number.isNaN(alarmTime.getTime())) {
		return internalJson({ error: 'Invalid dueDatetime' }, 400);
	}
	const jobToken = parseOptionalString(parsedBody.value.jobToken, 128);
	if (!jobToken) return internalJson({ error: 'jobToken required' }, 400);
	const current = await env.DB.prepare("SELECT job_token FROM notification_jobs WHERE reminder_id = ? AND operation = 'schedule'").bind(reminderId).first<{ job_token: string }>();
	if (current?.job_token !== jobToken) return internalJson({ success: true, superseded: true });
	// A completed occurrence survives transient schedule cleanup. Replaying
	// an accepted job (or reprojecting the same due time) cannot notify twice.
	// This only removes schedule state, so it does not need source authority.
	if (await state.storage.get<string>(COMPLETED_OCCURRENCE_KEY) === dueDatetime) {
		await env.DB.prepare('DELETE FROM scheduled_reminders WHERE reminder_id = ?').bind(reminderId).run();
		await state.storage.deleteAlarm();
		await clearScheduleState(state);
		return internalJson({ success: true });
	}
	if (!await hasNotificationAuthority(env.DB, reminderId, jobToken)) return internalJson({ error: 'Reminder source verification is pending' }, 409);
	const snapshot = await readSnapshot(state);
	const sameOccurrence = snapshot.reminder?.dueDatetime === dueDatetime;
	const body: ReminderData = {
		reminderId,
		scheduleToken: jobToken,
		content,
		dueDatetime,
		project,
	};
	try {
		if (!sameOccurrence) await Promise.all([
			state.storage.delete(PENDING_SUBSCRIPTION_IDS_KEY),
			state.storage.delete(DELIVERY_COMPLETE_KEY),
			state.storage.delete(RETRY_ATTEMPT_KEY),
			state.storage.delete(DELIVERY_FAILURE_KEY),
		]);
		await state.storage.put('reminder', body);
		// A repeated command must not reset recipient progress or rearm a
		// terminal failure. Exact retries repair publication without replay.
		if (!sameOccurrence || !snapshot.deliveryFailure && (snapshot.alarmTime !== null || snapshot.reminder?.scheduleToken !== body.scheduleToken || parsedBody.value.resume === true)) {
			await state.storage.setAlarm(sameOccurrence ? snapshot.alarmTime ?? alarmTime : alarmTime);
		}
		const failure = sameOccurrence ? snapshot.deliveryFailure : undefined;
		const saved = await env.DB.prepare(
			`INSERT OR REPLACE INTO scheduled_reminders
				(reminder_id, schedule_token, content, project, due_datetime, delivery_failed_at, delivery_error, delivery_attempts)
				SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM notification_jobs WHERE reminder_id = ? AND job_token = ? AND operation = 'schedule')`,
		).bind(reminderId, body.scheduleToken, content, project ?? null, dueDatetime, failure?.failedAt ?? null, failure?.error ?? null, failure?.attempts ?? null, reminderId, jobToken).run();
		if (changedRows(saved) !== 1) {
			await restoreSnapshot(state, snapshot);
			return internalJson({ success: true, superseded: true });
		}
	} catch {
		await restoreSnapshot(state, snapshot);
		return internalJson({ error: 'Failed to persist reminder schedule' }, 500);
	}
	return internalJson({ success: true });
}

async function cancelReminder(request: Request, context: ReminderScheduleContext): Promise<Response> {
	const { state, env } = context;
	const reminderId = parseOptionalString(new URL(request.url).searchParams.get('reminderId'), 256);
	if (!reminderId) {
		return internalJson({ error: 'reminderId required' }, 400);
	}
	const jobToken = parseOptionalString(new URL(request.url).searchParams.get('jobToken'), 128);
	if (!jobToken) return internalJson({ error: 'jobToken required' }, 400);
	try {
		const current = await env.DB.prepare("SELECT job_token FROM notification_jobs WHERE reminder_id = ? AND operation = 'cancel'").bind(reminderId).first<{ job_token: string }>();
		if (current?.job_token !== jobToken) return internalJson({ success: true, superseded: true });
		const deleted = await env.DB.prepare(`DELETE FROM scheduled_reminders WHERE reminder_id = ? AND EXISTS (SELECT 1 FROM notification_jobs WHERE reminder_id = ? AND job_token = ? AND operation = 'cancel')`)
			.bind(reminderId, reminderId, jobToken).run();
		if (changedRows(deleted) === 0) {
			const current = await env.DB.prepare('SELECT job_token FROM notification_jobs WHERE reminder_id = ?').bind(reminderId).first<{ job_token: string }>();
			if (current?.job_token !== jobToken) return internalJson({ success: true, superseded: true });
		}
		await state.storage.deleteAlarm();
		await clearScheduleState(state);
	} catch {
		return internalJson({ error: 'Failed to cancel reminder schedule' }, 500);
	}
	return internalJson({ success: true });
}

/** Deliver this object's scheduled reminder, or arm a retry when delivery fails. */
export async function deliverScheduledReminder(context: ReminderScheduleContext): Promise<void> {
	const reminder = await context.withStateLock(() => context.state.storage.get<ReminderData>('reminder'));
	if (!reminder) return;

	try {
		await deliverAndCleanup(context, reminder);
	} catch (error) {
		await scheduleRetryIfCurrent(context, reminder, error);
	}
}

async function deliverAndCleanup(context: ReminderScheduleContext, reminder: ReminderData): Promise<void> {
	const { state, env } = context;
	const db = env.DB;
	if (!await featureEnabled(db, 'reminders')) {
		await context.withStateLock(() => state.storage.deleteAlarm());
		return;
	}
	const scheduled = await db.prepare(
		`SELECT schedule_token, content, project, due_datetime
		FROM scheduled_reminders WHERE reminder_id = ?`,
	).bind(reminder.reminderId).first<ScheduledReminderRow>();
	if (
		!scheduled
		|| scheduled.schedule_token !== reminder.scheduleToken
		|| scheduled.due_datetime !== reminder.dueDatetime
	) {
		await clearStateIfCurrent(context, reminder.scheduleToken);
		return;
	}

	// The file commit and its projection job are atomic. Do not send from a
	// schedule whose source has changed while projection is still catching up.
	if (!await hasNotificationAuthority(db, reminder.reminderId, reminder.scheduleToken)) {
		await scheduleRetryIfCurrent(context, reminder, new Error('Reminder source is awaiting notification projection'));
		return;
	}

	const deliveryComplete = await state.storage.get<boolean>(DELIVERY_COMPLETE_KEY) === true;
	if (!deliveryComplete) {
		if (Date.now() - Date.parse(reminder.dueDatetime) >= MAX_DELIVERY_RETRY_AGE_MS) {
			throw new Error('Notification missed its 24-hour delivery window');
		}
		let pendingSubscriptionIds = await state.storage.get<string[]>(PENDING_SUBSCRIPTION_IDS_KEY);
		let subscriptions: PushSubscriptionRow[] | undefined;
		if (!pendingSubscriptionIds) {
			subscriptions = await listPushSubscriptions(db);
			const recipients = subscriptions.map(subscription => subscription.id);
			pendingSubscriptionIds = recipients;
			if (!await writeIfCurrent(context, reminder.scheduleToken, () => state.storage.put(PENDING_SUBSCRIPTION_IDS_KEY, recipients))) return;
		} else if (!await writeIfCurrent(context, reminder.scheduleToken, async () => {})) return;
		const delivery = await sendToAllSubscriptions(db, {
			title: scheduled.content,
			body: scheduled.project || '',
			tag: reminder.reminderId,
			project: scheduled.project ?? undefined,
			reminderId: reminder.reminderId,
		}, { origin: env.CRATE_PUBLIC_ORIGIN ?? '', subscriptionIds: pendingSubscriptionIds, subscriptions });
		if (delivery.failed > 0) {
			if (!await writeIfOccurrenceCurrent(context, reminder.dueDatetime, () => state.storage.put(PENDING_SUBSCRIPTION_IDS_KEY, delivery.failedSubscriptionIds))) return;
			throw new Error(`Push delivery failed for ${delivery.failed} subscription(s)`);
		}
		if (!await writeIfOccurrenceCurrent(context, reminder.dueDatetime, () => state.storage.put(DELIVERY_COMPLETE_KEY, true))) return;
	}
	if (!await writeIfOccurrenceCurrent(context, reminder.dueDatetime, () => state.storage.put(COMPLETED_OCCURRENCE_KEY, reminder.dueDatetime))) return;

	await db.prepare(
		'DELETE FROM scheduled_reminders WHERE reminder_id = ? AND schedule_token = ?',
	).bind(reminder.reminderId, reminder.scheduleToken).run();
	await clearStateIfCurrent(context, reminder.scheduleToken);
}

async function scheduleRetryIfCurrent(context: ReminderScheduleContext, reminder: ReminderData, error: unknown): Promise<void> {
	await writeIfCurrent(context, reminder.scheduleToken, () => scheduleRetry(context, reminder, error));
}

async function scheduleRetry({ state, env }: ReminderScheduleContext, reminder: ReminderData, error: unknown): Promise<void> {
	const current = await state.storage.get<ReminderData>('reminder');
	if (current?.scheduleToken !== reminder.scheduleToken) return;

	const attempt = await state.storage.get<number>(RETRY_ATTEMPT_KEY) ?? 0;
	const errorMessage = error instanceof Error ? error.message : String(error);
	const dueTime = new Date(reminder.dueDatetime).getTime();
	if (
		error instanceof PushPayloadError
		|| attempt >= MAX_DELIVERY_RETRY_ATTEMPTS
		|| (Number.isFinite(dueTime) && Date.now() - dueTime >= MAX_DELIVERY_RETRY_AGE_MS)
	) {
		const failure = {
			attempts: attempt,
			failedAt: new Date().toISOString(),
			error: errorMessage.slice(0, 1024),
		};
		await env.DB.prepare(`UPDATE scheduled_reminders SET delivery_failed_at = ?, delivery_error = ?, delivery_attempts = ?
			WHERE reminder_id = ? AND schedule_token = ?`).bind(failure.failedAt, failure.error, failure.attempts, reminder.reminderId, reminder.scheduleToken).run();
		await state.storage.put(DELIVERY_FAILURE_KEY, failure);
		await state.storage.deleteAlarm();
		console.error(`Reminder alarm ${reminder.reminderId} exhausted delivery retries:`, errorMessage);
		return;
	}
	const delay = retryDelayMs(attempt);
	await state.storage.put(RETRY_ATTEMPT_KEY, attempt + 1);
	await state.storage.setAlarm(Date.now() + delay);
	console.error(
		`Reminder alarm ${reminder.reminderId} failed; retrying in ${delay}ms:`,
		errorMessage,
	);
}

async function clearStateIfCurrent(context: ReminderScheduleContext, scheduleToken: string): Promise<void> {
	await writeIfCurrent(context, scheduleToken, async () => {
		await context.state.storage.deleteAlarm();
		await clearScheduleState(context.state);
	});
}

async function clearScheduleState(state: DurableObjectState): Promise<void> {
	// Preserve the last completed occurrence even after delivery/cancellation.
	for (const key of ['reminder', PENDING_SUBSCRIPTION_IDS_KEY, DELIVERY_COMPLETE_KEY, RETRY_ATTEMPT_KEY, DELIVERY_FAILURE_KEY]) await state.storage.delete(key);
}

async function readSnapshot(state: DurableObjectState): Promise<ReminderAlarmSnapshot> {
	const [reminder, alarmTime, pendingSubscriptionIds, deliveryComplete, retryAttempt, deliveryFailure] = await Promise.all([
		state.storage.get<ReminderData>('reminder'),
		state.storage.getAlarm(),
		state.storage.get<string[]>(PENDING_SUBSCRIPTION_IDS_KEY),
		state.storage.get<boolean>(DELIVERY_COMPLETE_KEY),
		state.storage.get<number>(RETRY_ATTEMPT_KEY),
		state.storage.get<DeliveryFailure>(DELIVERY_FAILURE_KEY),
	]);
	return { reminder, alarmTime, pendingSubscriptionIds, deliveryComplete, retryAttempt, deliveryFailure };
}

async function restoreSnapshot(state: DurableObjectState, snapshot: ReminderAlarmSnapshot): Promise<void> {
	try {
		await state.storage.deleteAlarm();
		await clearScheduleState(state);
		if (snapshot.reminder) await state.storage.put('reminder', snapshot.reminder);
		if (snapshot.pendingSubscriptionIds) {
			await state.storage.put(PENDING_SUBSCRIPTION_IDS_KEY, snapshot.pendingSubscriptionIds);
		}
		if (snapshot.deliveryComplete !== undefined) {
			await state.storage.put(DELIVERY_COMPLETE_KEY, snapshot.deliveryComplete);
		}
		if (snapshot.retryAttempt !== undefined) {
			await state.storage.put(RETRY_ATTEMPT_KEY, snapshot.retryAttempt);
		}
		if (snapshot.alarmTime !== null) await state.storage.setAlarm(snapshot.alarmTime);
		if (snapshot.deliveryFailure) await state.storage.put(DELIVERY_FAILURE_KEY, snapshot.deliveryFailure);
	} catch {
		// The schedule token prevents partially restored state from delivering.
	}
}
