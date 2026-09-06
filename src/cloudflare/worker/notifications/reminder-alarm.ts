import { runNotificationCoordinator } from '../notification-coordinator';
import type { Env } from '../types';
import { changedRows } from '../db';
import { parseJsonObject, parseNonNegativeInteger, parseOptionalString } from '../utils';
import { listPushSubscriptionIds, sendToAllSubscriptions } from './push';

interface ReminderData {
	reminderId: string;
	scheduleToken: string;
	content: string;
	project?: string;
	dueDatetime: string;
	priority?: number;
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
}

const PENDING_SUBSCRIPTION_IDS_KEY = 'pendingSubscriptionIds';
const DELIVERY_COMPLETE_KEY = 'deliveryComplete';
const RETRY_ATTEMPT_KEY = 'retryAttempt';
const RETRY_BASE_DELAY_MS = 60_000;
const RETRY_MAX_DELAY_MS = 6 * 60 * 60 * 1000;
const MAX_DELIVERY_RETRY_ATTEMPTS = 10;
const MAX_DELIVERY_RETRY_AGE_MS = 24 * 60 * 60 * 1000;
const DELIVERY_FAILURE_KEY = 'deliveryFailure';

function retryDelayMs(attempt: number): number {
	return Math.min(RETRY_BASE_DELAY_MS * (2 ** Math.min(attempt, 8)), RETRY_MAX_DELAY_MS);
}

export class ReminderAlarm implements DurableObject {
	private stateWrites: Promise<void> = Promise.resolve();

	// Serialize short state transitions, but allow a new schedule to arrive while
	// a push request is in flight. Every delivery write checks its schedule token.
	private withStateLock<T>(action: () => Promise<T>): Promise<T> {
		const result = this.stateWrites.then(action);
		this.stateWrites = result.then(() => undefined, () => undefined);
		return result;
	}

	private writeIfCurrent(token: string, action: () => Promise<unknown>): Promise<boolean> {
		return this.withStateLock(async () => {
			if ((await this.state.storage.get<ReminderData>('reminder'))?.scheduleToken !== token) return false;
			await action();
			return true;
		});
	}
	constructor(
		private state: DurableObjectState,
		private env: Pick<Env, 'DB'> & Partial<Env>,
	) {}

	fetch(request: Request): Promise<Response> {
		return this.withStateLock(() => this.handleFetch(request));
	}

	private async handleFetch(request: Request): Promise<Response> {
		const method = request.method;
		if (new URL(request.url).pathname === '/project' && method === 'POST') {
			await this.state.storage.put('projectionCoordinator', true);
			if (await this.state.storage.getAlarm() === null) await this.state.storage.setAlarm(Date.now() + 1);
			return new Response(JSON.stringify({ success: true }));
		}

		if (method === 'PUT') {
			const parsedBody = await parseJsonObject(request);
			if (!parsedBody.ok) return parsedBody.response;

			const reminderId = parseOptionalString(parsedBody.value.reminderId, 256);
			const content = parseOptionalString(parsedBody.value.content, 1024);
			const dueDatetime = parseOptionalString(parsedBody.value.dueDatetime, 128);
			const project = parsedBody.value.project === undefined
				? undefined
				: parseOptionalString(parsedBody.value.project, 256) || undefined;
			const priority = parsedBody.value.priority === undefined
				? undefined
				: parseNonNegativeInteger(parsedBody.value.priority) ?? undefined;
			if (!reminderId || !content || !dueDatetime) {
				return new Response(JSON.stringify({ error: 'Invalid reminder payload' }), { status: 400 });
			}

			const alarmTime = new Date(dueDatetime);
			if (Number.isNaN(alarmTime.getTime())) {
				return new Response(JSON.stringify({ error: 'Invalid dueDatetime' }), { status: 400 });
			}
			const jobToken = parseOptionalString(parsedBody.value.jobToken, 128);
			if (alarmTime.getTime() <= Date.now() && !jobToken) {
				return new Response(JSON.stringify({ error: 'dueDatetime must be in the future' }), { status: 400 });
			}

			if (jobToken) {
				const current = await this.env.DB.prepare("SELECT job_token FROM notification_jobs WHERE reminder_id = ? AND operation = 'schedule'").bind(reminderId).first<{ job_token: string }>();
				if (current?.job_token !== jobToken) return new Response(JSON.stringify({ success: true, superseded: true }));
			}
			const snapshot = await this.readSnapshot();
			const body: ReminderData = {
				reminderId,
				scheduleToken: crypto.randomUUID(),
				content,
				dueDatetime,
				project,
				priority,
			};
			try {
				await Promise.all([
					this.state.storage.delete(PENDING_SUBSCRIPTION_IDS_KEY),
					this.state.storage.delete(DELIVERY_COMPLETE_KEY),
					this.state.storage.delete(RETRY_ATTEMPT_KEY),
					this.state.storage.delete(DELIVERY_FAILURE_KEY),
				]);
				await this.state.storage.put('reminder', body);
				await this.state.storage.setAlarm(alarmTime);
				const saved = await this.env.DB.prepare(
					`INSERT OR REPLACE INTO scheduled_reminders
						(reminder_id, schedule_token, content, project, due_datetime)
					SELECT ?, ?, ?, ?, ? ${jobToken ? "WHERE EXISTS (SELECT 1 FROM notification_jobs WHERE reminder_id = ? AND job_token = ? AND operation = 'schedule')" : ''}`,
				).bind(reminderId, body.scheduleToken, content, project ?? null, dueDatetime, ...(jobToken ? [reminderId, jobToken] : [])).run();
				if (jobToken && changedRows(saved) !== 1) {
					await this.restoreSnapshot(snapshot);
					return new Response(JSON.stringify({ success: true, superseded: true }));
				}
			} catch {
				await this.restoreSnapshot(snapshot);
				return new Response(JSON.stringify({ error: 'Failed to persist reminder schedule' }), { status: 500 });
			}
			return new Response(JSON.stringify({ success: true }));
		}

		if (method === 'DELETE') {
			const reminderId = parseOptionalString(new URL(request.url).searchParams.get('reminderId'), 256);
			if (!reminderId) {
				return new Response(JSON.stringify({ error: 'reminderId required' }), { status: 400 });
			}
			const jobToken = new URL(request.url).searchParams.get('jobToken');
			try {
				if (jobToken) {
					const current = await this.env.DB.prepare("SELECT job_token FROM notification_jobs WHERE reminder_id = ? AND operation = 'cancel'").bind(reminderId).first<{ job_token: string }>();
					if (current?.job_token !== jobToken) return new Response(JSON.stringify({ success: true, superseded: true }));
				}
				const deleted = await this.env.DB.prepare(`DELETE FROM scheduled_reminders WHERE reminder_id = ? ${jobToken ? "AND EXISTS (SELECT 1 FROM notification_jobs WHERE reminder_id = ? AND job_token = ? AND operation = 'cancel')" : ''}`)
					.bind(reminderId, ...(jobToken ? [reminderId, jobToken] : [])).run();
				if (jobToken && changedRows(deleted) === 0) {
					const current = await this.env.DB.prepare('SELECT job_token FROM notification_jobs WHERE reminder_id = ?').bind(reminderId).first<{ job_token: string }>();
					if (current?.job_token !== jobToken) return new Response(JSON.stringify({ success: true, superseded: true }));
				}
				await this.state.storage.deleteAlarm();
				await this.state.storage.deleteAll();
			} catch {
				return new Response(JSON.stringify({ error: 'Failed to cancel reminder schedule' }), { status: 500 });
			}
			return new Response(JSON.stringify({ success: true }));
		}

		if (method === 'GET') {
			const reminder = await this.state.storage.get<ReminderData>('reminder');
			const alarm = await this.state.storage.getAlarm();
			return new Response(JSON.stringify({ reminder, alarmTime: alarm }));
		}

		return new Response('Method not allowed', { status: 405 });
	}

	async alarm(): Promise<void> {
		if (await this.state.storage.get<boolean>('projectionCoordinator')) {
			if (!this.env.BUCKET || !this.env.REMINDER_ALARMS) throw new Error('Projection bindings unavailable');
			await runNotificationCoordinator(this.state, this.env as Env);
			return;
		}
		const reminder = await this.state.storage.get<ReminderData>('reminder');
		if (!reminder) return;

		try {
			await this.deliverAndCleanup(reminder);
		} catch (error) {
			await this.scheduleRetryIfCurrent(reminder, error);
		}
	}

	private async deliverAndCleanup(reminder: ReminderData): Promise<void> {
		const db = this.env.DB;
		const scheduled = await db.prepare(
			`SELECT schedule_token, content, project, due_datetime
			FROM scheduled_reminders WHERE reminder_id = ?`,
		).bind(reminder.reminderId).first<ScheduledReminderRow>();
		if (
			!scheduled
			|| scheduled.schedule_token !== reminder.scheduleToken
			|| scheduled.due_datetime !== reminder.dueDatetime
		) {
			await this.clearStateIfCurrent(reminder.scheduleToken);
			return;
		}

        // The file commit and its projection job are atomic. Do not send from a
        // schedule whose source has changed while projection is still catching up.
        const projection = await db.prepare(`SELECT p.file_revision, f.storage_key,
          j.path AS pending_path, policy.enabled FROM scheduled_reminders s
          LEFT JOIN reminder_projections p ON p.reminder_id = s.reminder_id
          LEFT JOIN files f ON f.path = p.file_path
          LEFT JOIN notification_projection_jobs j ON j.path = p.file_path
          LEFT JOIN notification_policy policy ON policy.id = 1
          WHERE s.reminder_id = ?`).bind(reminder.reminderId)
          .first<{ file_revision: string | null; storage_key: string | null; pending_path: string | null; enabled: number }>();
        if (projection && (projection.file_revision === null || projection.pending_path || projection.file_revision !== projection.storage_key || projection.enabled === 0)) {
          await this.writeIfCurrent(reminder.scheduleToken, () => this.state.storage.setAlarm(Date.now() + 60_000));
          return;
        }

		const deliveryComplete = await this.state.storage.get<boolean>(DELIVERY_COMPLETE_KEY) === true;
		if (!deliveryComplete) {
			let pendingSubscriptionIds = await this.state.storage.get<string[]>(PENDING_SUBSCRIPTION_IDS_KEY);
			if (!pendingSubscriptionIds) {
				pendingSubscriptionIds = await listPushSubscriptionIds(db);
				if (!await this.writeIfCurrent(reminder.scheduleToken, () => this.state.storage.put(PENDING_SUBSCRIPTION_IDS_KEY, pendingSubscriptionIds))) return;
			}
			if (!await this.writeIfCurrent(reminder.scheduleToken, async () => {})) return;
			const delivery = await sendToAllSubscriptions(db, {
				title: scheduled.content,
				body: scheduled.project || '',
				tag: reminder.reminderId,
				project: scheduled.project ?? undefined,
				reminderId: reminder.reminderId,
			}, { subscriptionIds: pendingSubscriptionIds });
			if (delivery.failed > 0) {
				if (!await this.writeIfCurrent(reminder.scheduleToken, () => this.state.storage.put(PENDING_SUBSCRIPTION_IDS_KEY, delivery.failedSubscriptionIds))) return;
				throw new Error(`Push delivery failed for ${delivery.failed} subscription(s)`);
			}
			if (!await this.writeIfCurrent(reminder.scheduleToken, () => this.state.storage.put(DELIVERY_COMPLETE_KEY, true))) return;
		}

		await db.prepare(
			'DELETE FROM scheduled_reminders WHERE reminder_id = ? AND schedule_token = ?',
		).bind(reminder.reminderId, reminder.scheduleToken).run();
		await this.clearStateIfCurrent(reminder.scheduleToken);
	}

	private async scheduleRetryIfCurrent(reminder: ReminderData, error: unknown): Promise<void> {
		await this.writeIfCurrent(reminder.scheduleToken, () => this.scheduleRetry(reminder, error));
	}

	private async scheduleRetry(reminder: ReminderData, error: unknown): Promise<void> {
		const current = await this.state.storage.get<ReminderData>('reminder');
		if (current?.scheduleToken !== reminder.scheduleToken) return;

		const attempt = await this.state.storage.get<number>(RETRY_ATTEMPT_KEY) ?? 0;
		const errorMessage = error instanceof Error ? error.message : String(error);
		const dueTime = new Date(reminder.dueDatetime).getTime();
		if (
			attempt >= MAX_DELIVERY_RETRY_ATTEMPTS
			|| (Number.isFinite(dueTime) && Date.now() - dueTime >= MAX_DELIVERY_RETRY_AGE_MS)
		) {
			await this.state.storage.put(DELIVERY_FAILURE_KEY, {
				attempts: attempt,
				failedAt: new Date().toISOString(),
				error: errorMessage.slice(0, 1024),
			});
			await this.state.storage.deleteAlarm();
			console.error(`Reminder alarm ${reminder.reminderId} exhausted delivery retries:`, errorMessage);
			return;
		}
		const delay = retryDelayMs(attempt);
		await this.state.storage.put(RETRY_ATTEMPT_KEY, attempt + 1);
		await this.state.storage.setAlarm(Date.now() + delay);
		console.error(
			`Reminder alarm ${reminder.reminderId} failed; retrying in ${delay}ms:`,
			errorMessage,
		);
	}

	private async clearStateIfCurrent(scheduleToken: string): Promise<void> {
		await this.writeIfCurrent(scheduleToken, async () => {
			await this.state.storage.deleteAlarm();
			await this.state.storage.deleteAll();
		});
	}

	private async readSnapshot(): Promise<ReminderAlarmSnapshot> {
		const [reminder, alarmTime, pendingSubscriptionIds, deliveryComplete, retryAttempt] = await Promise.all([
			this.state.storage.get<ReminderData>('reminder'),
			this.state.storage.getAlarm(),
			this.state.storage.get<string[]>(PENDING_SUBSCRIPTION_IDS_KEY),
			this.state.storage.get<boolean>(DELIVERY_COMPLETE_KEY),
			this.state.storage.get<number>(RETRY_ATTEMPT_KEY),
		]);
		return { reminder, alarmTime, pendingSubscriptionIds, deliveryComplete, retryAttempt };
	}

	private async restoreSnapshot(snapshot: ReminderAlarmSnapshot): Promise<void> {
		try {
			await this.state.storage.deleteAlarm();
			await this.state.storage.deleteAll();
			if (snapshot.reminder) await this.state.storage.put('reminder', snapshot.reminder);
			if (snapshot.pendingSubscriptionIds) {
				await this.state.storage.put(PENDING_SUBSCRIPTION_IDS_KEY, snapshot.pendingSubscriptionIds);
			}
			if (snapshot.deliveryComplete !== undefined) {
				await this.state.storage.put(DELIVERY_COMPLETE_KEY, snapshot.deliveryComplete);
			}
			if (snapshot.retryAttempt !== undefined) {
				await this.state.storage.put(RETRY_ATTEMPT_KEY, snapshot.retryAttempt);
			}
			if (snapshot.alarmTime !== null) await this.state.storage.setAlarm(snapshot.alarmTime);
		} catch {
			// The schedule token prevents partially restored state from delivering.
		}
	}
}
