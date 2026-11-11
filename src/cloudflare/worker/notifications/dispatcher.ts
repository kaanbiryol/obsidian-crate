import { featureEnabled } from '../server/feature-policy';
import { PushPayloadError } from './payload-budget';
import type { Env } from '../types';
import { queryRows } from '../d1/db';
import { listPushSubscriptions, loadVapidKeys, sendToAllSubscriptions, type PushSubscriptionRow } from './push';
import { notificationAuthority } from '../reminders/source-state';
import { NOTIFICATION_DELIVERY_WINDOW_MS } from './projection-plan';
import { notificationRetryDelayMs } from './queue';
import { isD1DailyLimitError, nextD1DailyReset } from '../d1/d1-usage';
import { armReminderDispatcher } from '../coordinator/coordinator';
import type { StateLock } from '../coordinator/coordinator-requests';

/** Dispatcher role storage flag: its alarm delivers due reminders. */
export const DISPATCHER_KEY = 'reminderDispatcher';
const FAILURES_KEY = 'dispatchFailures';
const MAX_PASS_FAILURES = 8;
const MAX_DELIVERY_ATTEMPTS = 10;
/** Due reminders per pass. A pass makes one feature read, one due read, one authority
 * read, one recipient read, one VAPID key read (three on first use), at most one write per
 * push subscription (20 at most) when it prunes or quarantines it, and one outcome batch:
 * at most 28 queries, within D1_QUERIES_PER_INVOCATION. More due reminders chain another pass. */
export const DISPATCH_BATCH_SIZE = 20;

const NEXT_DUE_SQL = 'SELECT due_at AS dueAt FROM reminder_projections WHERE due_at IS NOT NULL ORDER BY due_at LIMIT 1';

interface DueReminder {
	id: string;
	token: string | null;
	filePath: string | null;
	due: string | null;
	content: string | null;
	project: string | null;
	dueAt: number;
	attempts: number;
	pending: string | null;
}

/** Asks the dispatcher role to deliver by `at`, or by the earliest scheduled reminder when
 * `at` is omitted. Throws when the role does not accept. */
export async function wakeReminderDispatcher(env: Env, at?: number): Promise<void> {
	if (!await armReminderDispatcher(env, at)) throw new Error('Unable to wake reminder delivery');
}

/** Called on the dispatcher role. Keeps its single alarm at the earliest requested time. */
export async function armDispatcher(state: DurableObjectState, env: Env, withStateLock: StateLock, at?: number | null): Promise<void> {
	const requested = at ?? (await env.DB.prepare(NEXT_DUE_SQL).first<{ dueAt: number }>())?.dueAt ?? null;
	await withStateLock(async () => {
		await state.storage.put(DISPATCHER_KEY, true);
		// A new schedule gets a fresh pass budget.
		await state.storage.delete(FAILURES_KEY);
		if (requested === null) return;
		const current = await state.storage.getAlarm();
		if (current === null || requested < current) await state.storage.setAlarm(Math.max(requested, Date.now()));
	});
}

/** The dispatcher role's alarm: one bounded delivery pass, then the next alarm. Paused
 * Reminders leave no alarm behind; resuming wakes the dispatcher again. */
export async function runReminderDispatch(state: DurableObjectState, env: Env, withStateLock: StateLock): Promise<void> {
	let next: number | null = null;
	try {
		next = await deliverDueReminders(env);
		if (await state.storage.get(FAILURES_KEY) !== undefined) await state.storage.delete(FAILURES_KEY);
	} catch (error) {
		if (isD1DailyLimitError(error)) {
			// Waiting for the 00:00 UTC reset uses no attempt. A delivery resumed past its
			// window records the failure once D1 accepts writes again.
			next = nextD1DailyReset();
			console.error('Reminder delivery is waiting for the D1 daily limit to reset.');
		} else {
			const failures = await state.storage.get<number>(FAILURES_KEY) ?? 0;
			await state.storage.put(FAILURES_KEY, failures + 1);
			if (failures + 1 < MAX_PASS_FAILURES) next = Date.now() + notificationRetryDelayMs(failures);
			console.error('Reminder delivery pass failed:', error);
		}
	}
	// An arm that arrived during the pass may already hold an earlier alarm.
	await withStateLock(async () => {
		const armed = await state.storage.getAlarm();
		const at = Math.min(armed ?? Infinity, next ?? Infinity);
		if (Number.isFinite(at) && at !== armed) await state.storage.setAlarm(Math.max(at, Date.now() + 1));
	});
}

/** Delivers up to one batch of due reminders and returns when the next one is due. Each
 * outcome is written after its push, so a lost write resends the same tag, which replaces
 * the displayed notification without alerting again. */
export async function deliverDueReminders(env: Env): Promise<number | null> {
	const db = env.DB;
	if (!await featureEnabled(db, 'reminders')) return null;
	const now = Date.now();
	const rows = await queryRows<DueReminder>(db.prepare(`SELECT reminder_id AS id, notification_token AS token, file_path AS filePath,
    due_datetime AS due, content, project, due_at AS dueAt, attempts, pending_subscriptions AS pending
    FROM reminder_projections WHERE due_at IS NOT NULL AND due_at <= ? ORDER BY due_at LIMIT ?`).bind(now, DISPATCH_BATCH_SIZE));
	if (!rows.length) return (await db.prepare(NEXT_DUE_SQL).first<{ dueAt: number }>())?.dueAt ?? null;
	const authorized = await notificationAuthority(db, rows.flatMap(row => row.token && row.filePath ? [{ id: row.id, token: row.token, filePath: row.filePath }] : []));
	let subscriptions: PushSubscriptionRow[] | undefined;
	let keys: Promise<CryptoKeyPair> | undefined;
	const outcomes: D1PreparedStatement[] = [];
	for (const row of rows) {
		// Writes for one occurrence check that it is still the scheduled one and that no
		// other pass moved its attempt time.
		const guard = 'WHERE reminder_id = ? AND due_datetime IS ? AND due_at = ?';
		const guardArgs = [row.id, row.due, row.dueAt];
		const fail = (message: string) => db.prepare(`UPDATE reminder_projections SET due_at = NULL, delivery_failed_at = ?, last_error = ? ${guard}`)
			.bind(new Date().toISOString(), message.slice(0, 1024), ...guardArgs);
		const retry = (message: string, pending: string | null) => {
			if (row.attempts >= MAX_DELIVERY_ATTEMPTS) return fail(message);
			return db.prepare(`UPDATE reminder_projections SET attempts = ?, due_at = ?, pending_subscriptions = ?, last_error = ? ${guard}`)
				.bind(row.attempts + 1, Date.now() + notificationRetryDelayMs(row.attempts), pending, message.slice(0, 1024), ...guardArgs);
		};
		const dueTime = row.due ? Date.parse(row.due) : NaN;
		if (!Number.isFinite(dueTime) || row.content === null) { outcomes.push(fail('Notification schedule is invalid')); continue; }
		if (Date.now() - dueTime >= NOTIFICATION_DELIVERY_WINDOW_MS) { outcomes.push(fail('Notification missed its 24-hour delivery window')); continue; }
		// The file commit and its projection job are atomic. Do not send from a schedule
		// whose source has changed while projection is still catching up.
		if (!authorized.has(row.id)) { outcomes.push(retry('Reminder source is awaiting notification projection', row.pending)); continue; }
		try {
			subscriptions ??= await listPushSubscriptions(db);
			const delivery = await sendToAllSubscriptions(db, {
				title: row.content,
				body: row.project || '',
				// A notification replaces one with the same tag without alerting. Retries of this
				// occurrence replace it; the next occurrence of a recurring reminder alerts again.
				tag: `${row.id}:${row.due}`,
				project: row.project ?? undefined,
				reminderId: row.id,
			}, {
				origin: env.CRATE_PUBLIC_ORIGIN ?? '',
				subscriptionIds: row.pending === null ? undefined : JSON.parse(row.pending) as string[],
				subscriptions,
				keys: () => keys ??= loadVapidKeys(db),
			});
			const removed = new Set(delivery.removedSubscriptionIds);
			if (removed.size) subscriptions = subscriptions.filter(subscription => !removed.has(subscription.id));
			if (delivery.failed > 0) {
				outcomes.push(retry(`Push delivery failed for ${delivery.failed} subscription(s)`, JSON.stringify(delivery.failedSubscriptionIds)));
				continue;
			}
			// Recorded even if the reminder moved or changed meanwhile: this occurrence was sent.
			const same = 'due_datetime IS ?';
			outcomes.push(db.prepare(`UPDATE reminder_projections SET delivered_due = ?,
        due_at = CASE WHEN ${same} THEN NULL ELSE due_at END,
        attempts = CASE WHEN ${same} THEN 0 ELSE attempts END,
        pending_subscriptions = CASE WHEN ${same} THEN NULL ELSE pending_subscriptions END,
        last_error = CASE WHEN ${same} THEN NULL ELSE last_error END
        WHERE reminder_id = ?`).bind(row.due, row.due, row.due, row.due, row.due, row.id));
		} catch (error) {
			if (isD1DailyLimitError(error)) throw error;
			const message = error instanceof Error ? error.message : String(error);
			outcomes.push(error instanceof PushPayloadError ? fail(message) : retry(message, row.pending));
		}
	}
	// Outcomes move every attempt of this pass out of the due range, so an earliest due time
	// that is already past means more due reminders: the next pass then runs at once.
	const results = await db.batch([...outcomes, db.prepare(NEXT_DUE_SQL)]);
	return (results.at(-1) as { results: Array<{ dueAt: number }> } | undefined)?.results[0]?.dueAt ?? null;
}
