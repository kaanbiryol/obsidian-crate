import { featureEnabled } from '../server/feature-policy';
import { NOTIFICATION_POLICY_COLUMNS, notificationPolicyFromRow, type NotificationPolicyRow } from './policy';
import { isValidPushEndpoint } from './push-endpoint';
import { corsResponse } from '../http/cors';
import { queryRows } from '../d1/db';
import { sendToAllSubscriptions } from './push';
import { parseJsonObject, parseOptionalString } from '../http/request-validation';

export async function handleSubscribe(request: Request, db: D1Database, ownerTokenId: string): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const endpoint = parseOptionalString(parsedBody.value.endpoint, 2048);
	const keys = parsedBody.value.keys;
	const p256dh = keys && typeof keys === 'object'
		? parseOptionalString((keys as Record<string, unknown>).p256dh, 512)
		: null;
	const auth = keys && typeof keys === 'object'
		? parseOptionalString((keys as Record<string, unknown>).auth, 512)
		: null;
	const deviceName = parsedBody.value.deviceName === undefined
		? null
		: parseOptionalString(parsedBody.value.deviceName, 128);

	if (!endpoint || !p256dh || !auth) {
		return corsResponse({ error: 'endpoint and keys (p256dh, auth) required' }, 400);
	}
	if (parsedBody.value.deviceName !== undefined && deviceName === null) {
		return corsResponse({ error: 'Invalid deviceName' }, 400);
	}
	if (!isValidPushEndpoint(endpoint)) {
		return corsResponse({ error: 'Invalid endpoint' }, 400);
	}

	const id = crypto.randomUUID();
	// Some revocations commit outside the coordinator lock, so the owner must still exist here.
	const insert = db.prepare(`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, device_name, owner_token_id, folder_path)
		SELECT ?, ?, ?, ?, ?, ?, (SELECT folder_path FROM auth_tokens WHERE id = ?)
		WHERE ((SELECT COUNT(*) FROM push_subscriptions) < 20 OR EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND owner_token_id = ?))
		AND ((SELECT COUNT(*) FROM push_subscriptions WHERE owner_token_id = ?) < 5 OR EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND owner_token_id = ?))
		AND EXISTS (SELECT 1 FROM auth_tokens WHERE id = ? AND (expires_at IS NULL OR expires_at > ?))
		ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
		device_name = excluded.device_name, disabled_at = NULL, last_error = NULL
		WHERE push_subscriptions.owner_token_id = excluded.owner_token_id
		AND (push_subscriptions.p256dh, push_subscriptions.auth, push_subscriptions.device_name, push_subscriptions.disabled_at, push_subscriptions.last_error)
		  IS NOT (excluded.p256dh, excluded.auth, excluded.device_name, NULL, NULL)`)
		.bind(id, endpoint, p256dh, auth, deviceName, ownerTokenId, ownerTokenId, endpoint, ownerTokenId, ownerTokenId, endpoint, ownerTokenId, ownerTokenId, Date.now());
	// Every app open confirms its subscription, so an unchanged one writes nothing. The
	// row, its live owner and the policy are read in the same transaction. Confirmation
	// retries must preserve IDs already captured by delivery work.
	const [, confirmedRows, policyRows] = await db.batch<Record<string, unknown>>([insert,
		db.prepare(`SELECT id, folder_path FROM push_subscriptions WHERE endpoint = ? AND owner_token_id = ?
		AND EXISTS (SELECT 1 FROM auth_tokens WHERE id = ? AND (expires_at IS NULL OR expires_at > ?))`).bind(endpoint, ownerTokenId, ownerTokenId, Date.now()),
		db.prepare(`SELECT ${NOTIFICATION_POLICY_COLUMNS} FROM notification_policy WHERE id = 1`),
	]);
	const confirmed = (confirmedRows?.results as Array<{ id: string; folder_path: string | null }> | undefined)?.[0];
	if (!confirmed) return corsResponse({ error: 'Subscription limit reached or endpoint already enrolled. Remove an old device before trying again.' }, 429);
	// Browser permission confirms this device, but the vault's shared policy can
	// still prevent scheduling. Report both without changing the user's policy.
	const policy = notificationPolicyFromRow((policyRows?.results as NotificationPolicyRow[] | undefined)?.[0] ?? null);
	const notificationsEnabled = Boolean(policy && policy.enabled !== false
		&& (!confirmed.folder_path || confirmed.folder_path === policy.folderPath)
		&& await featureEnabled(db, 'reminders'));
	return corsResponse({ id: confirmed.id, notificationsEnabled });
}

export async function handleUnsubscribe(request: Request, db: D1Database, ownerTokenId?: string): Promise<Response> {
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const id = parseOptionalString(parsedBody.value.id, 128);
	const endpoint = parseOptionalString(parsedBody.value.endpoint, 2048);
	if (!id && !endpoint) return corsResponse({ error: 'id or endpoint required' }, 400);
	if (endpoint && !isValidPushEndpoint(endpoint)) {
		return corsResponse({ error: 'Invalid endpoint' }, 400);
	}

	const statement = id
		? db.prepare(`DELETE FROM push_subscriptions WHERE id = ? ${ownerTokenId ? 'AND owner_token_id = ?' : ''}`).bind(id, ...(ownerTokenId ? [ownerTokenId] : []))
		: db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ? ${ownerTokenId ? 'AND owner_token_id = ?' : ''}`).bind(endpoint, ...(ownerTokenId ? [ownerTokenId] : []));
	await statement.run();
	return corsResponse({ success: true });
}

export async function handleListSubscriptions(db: D1Database): Promise<Response> {
	const rows = await queryRows(
		db.prepare(`SELECT id, device_name, created_at, disabled_at, last_error
			FROM push_subscriptions ORDER BY created_at DESC`)
	);
	return corsResponse({ subscriptions: rows });
}

export async function handleTestPush(db: D1Database, origin: string): Promise<Response> {
	if (!await featureEnabled(db, 'reminders')) return corsResponse({ error: 'Reminders are paused.', code: 'feature_paused' }, 423);
	const delivery = await sendToAllSubscriptions(db, {
		title: 'Crate Test',
		body: 'If you see this, push notifications are working!',
		tag: 'crate-test',
	}, { origin });
	return corsResponse({
		sent: delivery.sent,
		failed: delivery.failed,
		pruned: delivery.pruned,
		quarantined: delivery.quarantined,
		errors: delivery.errors,
	});
}
