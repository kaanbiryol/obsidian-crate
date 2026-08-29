import {
	generateVapidKeys, serializeVapidKeys, deserializeVapidKeys,
	sendPushNotification,
} from 'web-push-browser';
import { queryRows } from './db';

interface SerializedVapidKeys {
	publicKey: string;
	privateKey: string;
}

interface PushSubscriptionRow {
	id: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	device_name: string | null;
	created_at: string;
}

const VAPID_EMAIL = 'crate-push@example.com';

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

export function createDeclarativePushPayload(payload: PushNotificationPayload): DeclarativePushPayload {
	const params = new URLSearchParams();
	if (payload.project) params.set('project', payload.project);
	if (payload.reminderId) params.set('reminderId', payload.reminderId);

	return {
		web_push: 8030,
		notification: {
			title: payload.title,
			body: payload.body,
			navigate: `/notifications${params.size > 0 ? `?${params.toString()}` : ''}`,
			...(payload.tag ? { tag: payload.tag } : {}),
			icon: '/notifications/crate-icon-192.png',
			data: {
				project: payload.project ?? '',
				reminderId: payload.reminderId ?? '',
			},
		},
	};
}

export async function getOrCreateVapidKeys(db: D1Database): Promise<SerializedVapidKeys> {
	const rows = await queryRows<{ public_key: string; private_key: string }>(
		db.prepare('SELECT public_key, private_key FROM vapid_keys WHERE id = 1')
	);

	if (rows.length > 0) {
		return { publicKey: rows[0].public_key, privateKey: rows[0].private_key };
	}

	const keyPair = await generateVapidKeys();
	const serialized = await serializeVapidKeys(keyPair);

	await db.prepare(
		'INSERT INTO vapid_keys (id, public_key, private_key) VALUES (1, ?, ?)'
	).bind(serialized.publicKey, serialized.privateKey).run();

	return serialized;
}

export async function sendToAllSubscriptions(
	db: D1Database,
	payload: PushNotificationPayload,
): Promise<{ sent: number; failed: number; pruned: number; errors: string[] }> {

	const serializedKeys = await getOrCreateVapidKeys(db);
	const keys = await deserializeVapidKeys(serializedKeys);

	const subs = await queryRows<PushSubscriptionRow>(
		db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions')
	);

	if (subs.length === 0) {
		return { sent: 0, failed: 0, pruned: 0, errors: ['no subscriptions in db'] };
	}

	const payloadStr = JSON.stringify(createDeclarativePushPayload(payload));
	let sent = 0;
	let failed = 0;
	let pruned = 0;
	const errors: string[] = [];

	await Promise.all(subs.map(async (sub) => {
		try {
			const resp = await sendPushNotification(
				keys,
				{ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
				VAPID_EMAIL,
				payloadStr,
			);

			if (resp.status === 404 || resp.status === 410) {
				await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run();
				pruned++;
			} else if (resp.ok) {
				sent++;
			} else {
				const body = await resp.text().catch(() => '');
				const msg = `${sub.id}: ${resp.status} ${body}`;
				console.error('Push failed:', msg);
				errors.push(msg);
				failed++;
			}
		} catch (err) {
			const msg = `${sub.id}: ${err instanceof Error ? err.message : String(err)}`;
			console.error('Push error:', msg);
			errors.push(msg);
			failed++;
		}
	}));

	return { sent, failed, pruned, errors };
}
