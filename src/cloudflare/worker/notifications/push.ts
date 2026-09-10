import { fitPushDisplay } from './payload-budget';
import {
	deserializeVapidKeys,
	generateVapidKeys,
	serializeVapidKeys,
} from 'web-push-browser';
import { queryRows } from '../db';
import { sendPushNotificationWithoutContact } from './web-push';
import { PUSH_RECIPIENT_AUTHORITY } from './recipient-authority';

interface SerializedVapidKeys {
	publicKey: string;
	privateKey: string;
}

interface PushSubscriptionRow {
	id: string;
	endpoint: string;
	p256dh: string;
	auth: string;
}

export interface PushDeliveryResult {
	sent: number;
	failed: number;
	pruned: number;
	quarantined: number;
	errors: string[];
	failedSubscriptionIds: string[];
}

const PUSH_DELIVERY_CONCURRENCY = 6;

export interface PushNotificationPayload {
	title: string;
	body: string;
	tag?: string;
	project?: string;
	reminderId?: string;
}

interface DeclarativePushPayload {
	web_push: 8030;
	notification: {
		title: string;
		body: string;
		navigate: string;
		tag?: string;
		icon: string;
		data: {
			project: string;
			reminderId: string;
		};
	};
}

// iOS may accept a push but never display it when declarative URLs are relative.
export function createDeclarativePushPayload(payload: PushNotificationPayload, origin: string): DeclarativePushPayload {
	const params = new URLSearchParams();
	// The stable ID locates the reminder and its current project after a move.
	if (payload.project && !payload.reminderId) params.set('project', payload.project);
	if (payload.reminderId) params.set('reminderId', payload.reminderId);

	return fitPushDisplay({
		web_push: 8030,
		notification: {
			title: payload.title,
			body: payload.body,
			navigate: new URL(`/notifications${params.size > 0 ? `?${params.toString()}` : ''}`, origin).href,
			...(payload.tag ? { tag: payload.tag } : {}),
			icon: new URL('/notifications/crate-icon-192.png', origin).href,
			data: {
				project: payload.reminderId ? '' : payload.project ?? '',
				reminderId: payload.reminderId ?? '',
			},
		},
	});
}

export async function getOrCreateVapidKeys(db: D1Database): Promise<SerializedVapidKeys> {
	const readPersistedKeys = async (): Promise<SerializedVapidKeys | null> => {
		const rows = await queryRows<{ public_key: string; private_key: string }>(
			db.prepare('SELECT public_key, private_key FROM vapid_keys WHERE id = 1'),
		);
		const row = rows[0];
		return row ? { publicKey: row.public_key, privateKey: row.private_key } : null;
	};

	const existingKeys = await readPersistedKeys();
	if (existingKeys) return existingKeys;

	const keyPair = await generateVapidKeys();
	const serialized = await serializeVapidKeys(keyPair);
	await db.prepare(
		'INSERT OR IGNORE INTO vapid_keys (id, public_key, private_key) VALUES (1, ?, ?)',
	).bind(serialized.publicKey, serialized.privateKey).run();

	const persistedKeys = await readPersistedKeys();
	if (!persistedKeys) throw new Error('Failed to persist VAPID keys');
	return persistedKeys;
}

export async function listPushSubscriptionIds(db: D1Database): Promise<string[]> {
	const rows = await queryRows<{ id: string }>(db.prepare(`SELECT id FROM push_subscriptions WHERE ${PUSH_RECIPIENT_AUTHORITY}`).bind(Date.now()));
	return rows.map((row) => row.id);
}

async function runBounded<T>(items: readonly T[], worker: (item: T) => Promise<void>): Promise<void> {
	let nextIndex = 0;
	const workers = Array.from(
		{ length: Math.min(PUSH_DELIVERY_CONCURRENCY, items.length) },
		async () => {
			while (nextIndex < items.length) {
				const index = nextIndex;
				nextIndex += 1;
				const item = items[index];
				if (item !== undefined) await worker(item);
			}
		},
	);
	await Promise.all(workers);
}

function isExpiredSubscriptionStatus(status: number): boolean {
	return status === 404 || status === 410;
}

function isRetryablePushStatus(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function sendToAllSubscriptions(
	db: D1Database,
	payload: PushNotificationPayload,
	options: { origin: string; subscriptionIds?: readonly string[] },
): Promise<PushDeliveryResult> {
	const allSubscriptions = await queryRows<PushSubscriptionRow>(
		db.prepare(`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE ${PUSH_RECIPIENT_AUTHORITY}`).bind(Date.now()),
	);
	const requestedIds = options.subscriptionIds ? new Set(options.subscriptionIds) : null;
	const subscriptions = requestedIds
		? allSubscriptions.filter((subscription) => requestedIds.has(subscription.id))
		: allSubscriptions;

	if (subscriptions.length === 0) {
		return {
			sent: 0,
			failed: 0,
			pruned: 0,
			quarantined: 0,
			errors: requestedIds?.size ? [] : ['no subscriptions in db'],
			failedSubscriptionIds: [],
		};
	}

	const serializedKeys = await getOrCreateVapidKeys(db);
	const keys = await deserializeVapidKeys(serializedKeys);
	const payloadString = JSON.stringify(createDeclarativePushPayload(payload, options.origin));
	let sent = 0;
	let failed = 0;
	let pruned = 0;
	let quarantined = 0;
	const errors: string[] = [];
	const failedSubscriptionIds: string[] = [];

	await runBounded(subscriptions, async (subscription) => {
		try {
			const response = await sendPushNotificationWithoutContact(
				keys,
				{
					endpoint: subscription.endpoint,
					keys: { p256dh: subscription.p256dh, auth: subscription.auth },
				},
				payloadString,
			);

			if (isExpiredSubscriptionStatus(response.status)) {
				await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(subscription.id).run();
				pruned += 1;
			} else if (response.ok) {
				sent += 1;
			} else if (isRetryablePushStatus(response.status)) {
				await response.body?.cancel();
				const message = `${subscription.id}: push service returned ${response.status}`;
				console.error('Push failed:', message);
				errors.push(message);
				failed += 1;
				failedSubscriptionIds.push(subscription.id);
			} else {
				await response.body?.cancel();
				const message = `${subscription.id}: push service returned ${response.status}`;
				await db.prepare(`UPDATE push_subscriptions
					SET disabled_at = datetime('now'), last_error = ? WHERE id = ?`)
					.bind(message.slice(0, 1024), subscription.id)
					.run();
				console.error('Push subscription quarantined:', message);
				errors.push(message);
				quarantined += 1;
			}
		} catch (error) {
			const message = `${subscription.id}: ${error instanceof Error ? error.message : String(error)}`;
			console.error('Push error:', message);
			errors.push(message);
			failed += 1;
			failedSubscriptionIds.push(subscription.id);
		}
	});

	return { sent, failed, pruned, quarantined, errors, failedSubscriptionIds };
}
