import { readableLinkText } from '../../../reminders/core/grammar/markdownLinks';
import { fitPushDisplay } from './payload-budget';
import { queryRows } from '../d1/db';
import { mapBounded } from '../../../platform/map-bounded';
import { getOrCreateVapidKeys, importVapidKeys } from './vapid-keys';
import { sendPushNotificationWithoutContact } from './web-push';
import { PUSH_RECIPIENT_AUTHORITY } from './recipient-authority';
import { parseEncryptedNotification, type EncryptedNotification } from '../../../encryption/notification-format';
import { SIMULTANEOUS_OPEN_CONNECTIONS } from '../d1/platform-limits';

export interface PushSubscriptionRow {
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


export interface PushNotificationPayload {
	title: string;
	body: string;
	tag?: string;
	project?: string;
	reminderId?: string;
}

interface DeclarativePushPayload {
	web_push: 8030;
	mutable?: boolean;
	notification: {
		title: string;
		mutable?: boolean;
		body: string;
		navigate: string;
		tag?: string;
		icon: string;
		data: {
			project: string;
			reminderId: string;
			encrypted?: EncryptedNotification;
		};
	};
}

// iOS may accept a push but never display it when declarative URLs are relative.
export function createDeclarativePushPayload(payload: PushNotificationPayload, origin: string): DeclarativePushPayload {
	const encrypted = parseEncryptedNotification(payload.title);
	const params = new URLSearchParams();
	// The stable ID locates the reminder and its current project after a move.
	if (payload.project && !payload.reminderId) params.set('project', payload.project);
	if (payload.reminderId) params.set('reminderId', payload.reminderId);

	return fitPushDisplay({
		web_push: 8030,
		...(encrypted ? { mutable: true } : {}),
		notification: {
			title: encrypted ? 'Crate reminder' : readableLinkText(payload.title),
			body: encrypted ? 'Open Crate to view your reminder.' : payload.body,
			// Older Safari releases read mutable here; the standard uses the root.
			...(encrypted ? { mutable: true } : {}),
			navigate: new URL(`/notifications${params.size > 0 ? `?${params.toString()}` : ''}`, origin).href,
			...(payload.tag ? { tag: payload.tag } : {}),
			icon: new URL('/notifications/crate-icon-192.png', origin).href,
			data: {
				project: payload.reminderId ? '' : payload.project ?? '',
				reminderId: payload.reminderId ?? '',
				...(encrypted ? { encrypted } : {}),
			},
		},
	});
}

export function listPushSubscriptions(db: D1Database): Promise<PushSubscriptionRow[]> {
	return queryRows<PushSubscriptionRow>(
		db.prepare(`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE ${PUSH_RECIPIENT_AUTHORITY}`).bind(Date.now()),
	);
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
	options: { origin: string; subscriptionIds?: readonly string[]; subscriptions?: readonly PushSubscriptionRow[] },
): Promise<PushDeliveryResult> {
	// Callers that just read the recipients pass them in to avoid a second query.
	const allSubscriptions = options.subscriptions ?? await listPushSubscriptions(db);
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
	const keys = await importVapidKeys(serializedKeys);
	const authorizations = new Map<string, Promise<string>>();
	const payloadString = JSON.stringify(createDeclarativePushPayload(payload, options.origin));
	let sent = 0;
	let failed = 0;
	let pruned = 0;
	let quarantined = 0;
	const errors: string[] = [];
	const failedSubscriptionIds: string[] = [];

	// Each delivery records its own failure, so one failed push never stops the others.
	await mapBounded(subscriptions, SIMULTANEOUS_OPEN_CONNECTIONS, async (subscription) => {
		try {
			const response = await sendPushNotificationWithoutContact(
				keys,
				{
					endpoint: subscription.endpoint,
					keys: { p256dh: subscription.p256dh, auth: subscription.auth },
				},
				payloadString,
				authorizations,
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
