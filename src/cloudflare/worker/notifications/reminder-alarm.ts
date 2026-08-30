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
	constructor(
		private state: DurableObjectState,
		private env: { DB: D1Database },
	) {}

	async fetch(request: Request): Promise<Response> {
		const method = request.method;

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
			if (alarmTime.getTime() <= Date.now()) {
				return new Response(JSON.stringify({ error: 'dueDatetime must be in the future' }), { status: 400 });
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
				]);
				await this.state.storage.put('reminder', body);
				await this.state.storage.setAlarm(alarmTime);
				await this.env.DB.prepare(
					`INSERT OR REPLACE INTO scheduled_reminders
						(reminder_id, schedule_token, content, project, due_datetime)
					VALUES (?, ?, ?, ?, ?)`,
				).bind(reminderId, body.scheduleToken, content, project ?? null, dueDatetime).run();
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
			try {
				await this.env.DB.prepare('DELETE FROM scheduled_reminders WHERE reminder_id = ?')
					.bind(reminderId).run();
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

		const deliveryComplete = await this.state.storage.get<boolean>(DELIVERY_COMPLETE_KEY) === true;
		if (!deliveryComplete) {
			let pendingSubscriptionIds = await this.state.storage.get<string[]>(PENDING_SUBSCRIPTION_IDS_KEY);
			if (!pendingSubscriptionIds) {
				pendingSubscriptionIds = await listPushSubscriptionIds(db);
				await this.state.storage.put(PENDING_SUBSCRIPTION_IDS_KEY, pendingSubscriptionIds);
			}
			const delivery = await sendToAllSubscriptions(db, {
				title: scheduled.content,
				body: scheduled.project || '',
				tag: reminder.reminderId,
				project: scheduled.project ?? undefined,
				reminderId: reminder.reminderId,
			}, { subscriptionIds: pendingSubscriptionIds });
			if (delivery.failed > 0) {
				await this.state.storage.put(PENDING_SUBSCRIPTION_IDS_KEY, delivery.failedSubscriptionIds);
				throw new Error(`Push delivery failed for ${delivery.failed} subscription(s)`);
			}
			await this.state.storage.put(DELIVERY_COMPLETE_KEY, true);
		}

		await db.prepare(
			'DELETE FROM scheduled_reminders WHERE reminder_id = ? AND schedule_token = ?',
		).bind(reminder.reminderId, reminder.scheduleToken).run();
		await this.clearStateIfCurrent(reminder.scheduleToken);
	}

	private async scheduleRetryIfCurrent(reminder: ReminderData, error: unknown): Promise<void> {
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
		const current = await this.state.storage.get<ReminderData>('reminder');
		if (current?.scheduleToken === scheduleToken) await this.state.storage.deleteAll();
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
