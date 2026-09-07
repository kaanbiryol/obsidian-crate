import { isValidPushEndpoint } from './notifications/push-endpoint';
import { corsResponse } from './cors';
import { changedRows, queryRows } from './db';
import { sendToAllSubscriptions } from './push';
import { parseJsonObject, parseOptionalString } from './utils';

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
	const insert = db.prepare(`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, device_name, owner_token_id, folder_path)
		SELECT ?, ?, ?, ?, ?, ?, (SELECT folder_path FROM auth_tokens WHERE id = ?)
		WHERE ((SELECT COUNT(*) FROM push_subscriptions) < 20 OR EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND owner_token_id = ?))
		AND ((SELECT COUNT(*) FROM push_subscriptions WHERE owner_token_id = ?) < 5 OR EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND owner_token_id = ?))
		ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
		device_name = excluded.device_name, disabled_at = NULL, last_error = NULL
		WHERE push_subscriptions.owner_token_id = excluded.owner_token_id`)
		.bind(id, endpoint, p256dh, auth, deviceName, ownerTokenId, ownerTokenId, endpoint, ownerTokenId, ownerTokenId, endpoint, ownerTokenId);
	const result = await insert.run();
	if (changedRows(result) !== 1) return corsResponse({ error: 'Subscription limit reached or endpoint already enrolled. Remove an old device before trying again.' }, 429);
	// Confirmation retries must preserve IDs already captured by delivery work.
	const confirmed = await db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ? AND owner_token_id = ?')
		.bind(endpoint, ownerTokenId).first<{ id: string }>();
	if (!confirmed) return corsResponse({ error: 'Subscription registration changed. Try again.' }, 503);
	return corsResponse({ id: confirmed.id });
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

export async function handleTestPush(db: D1Database): Promise<Response> {
	const delivery = await sendToAllSubscriptions(db, {
		title: 'Crate Test',
		body: 'If you see this, push notifications are working!',
		tag: 'crate-test',
	});
	return corsResponse({
		sent: delivery.sent,
		failed: delivery.failed,
		pruned: delivery.pruned,
		quarantined: delivery.quarantined,
		errors: delivery.errors,
	});
}
