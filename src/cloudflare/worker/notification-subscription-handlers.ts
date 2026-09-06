import { isValidPushEndpoint } from './notifications/push-endpoint';
import { sha256Hex } from './auth';
import { corsResponse } from './cors';
import { changedRows, queryRows } from './db';
import { sendToAllSubscriptions } from './push';
import { purgeExpiredPushEnrollmentTokens } from './push-enrollment';
import { parseJsonObject, parseOptionalString } from './utils';

export async function handleSubscribe(request: Request, db: D1Database, ownerTokenId?: string): Promise<Response> {
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
	const enrollmentToken = request.headers.get('X-Crate-Enrollment-Token')?.trim() || '';
	const tokenHash = enrollmentToken ? await sha256Hex(enrollmentToken) : null;
	const owner = ownerTokenId ?? (tokenHash ? `enrollment:${tokenHash}` : null);
	if (!owner) return corsResponse({ error: 'Authenticated subscription owner required' }, 401);
	if (tokenHash) await purgeExpiredPushEnrollmentTokens(db);
	const gate = tokenHash ? 'AND EXISTS (SELECT 1 FROM push_enrollment_tokens WHERE token_hash = ? AND expires_at > ?)' : '';
	const insert = db.prepare(`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, device_name, owner_token_id, folder_path)
		SELECT ?, ?, ?, ?, ?, ?, (SELECT folder_path FROM auth_tokens WHERE id = ?)
		WHERE ((SELECT COUNT(*) FROM push_subscriptions) < 20 OR EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND owner_token_id = ?))
		AND ((SELECT COUNT(*) FROM push_subscriptions WHERE owner_token_id = ?) < 5 OR EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND owner_token_id = ?)) ${gate}
		ON CONFLICT(endpoint) DO UPDATE SET id = excluded.id, p256dh = excluded.p256dh, auth = excluded.auth,
		device_name = excluded.device_name, disabled_at = NULL, last_error = NULL
		WHERE push_subscriptions.owner_token_id = excluded.owner_token_id`)
		.bind(id, endpoint, p256dh, auth, deviceName, owner, owner, endpoint, owner, owner, endpoint, owner, ...(tokenHash ? [tokenHash, Date.now()] : []));
	const results = await db.batch([insert, ...(tokenHash ? [db.prepare('DELETE FROM push_enrollment_tokens WHERE token_hash = ? AND changes() = 1').bind(tokenHash)] : [])]);
	if (changedRows(results[0]) !== 1) return corsResponse({ error: 'Subscription limit reached, endpoint already enrolled, or enrollment expired. Remove an old device or open a fresh link.' }, 429);
	return corsResponse({ id });
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
