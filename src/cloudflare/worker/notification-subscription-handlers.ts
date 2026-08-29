import { sha256Hex } from './auth';
import { corsResponse } from './cors';
import { changedRows, queryRows } from './db';
import { sendToAllSubscriptions } from './push';
import { purgeExpiredPushEnrollmentTokens } from './push-enrollment';
import { parseJsonObject, parseOptionalString } from './utils';

function isValidPushEndpoint(endpoint: string): boolean {
	try {
		return new URL(endpoint).protocol === 'https:';
	} catch {
		return false;
	}
}

export async function handleSubscribe(request: Request, db: D1Database): Promise<Response> {
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
	if (enrollmentToken) {
		await purgeExpiredPushEnrollmentTokens(db);
		const now = Date.now();
		const tokenHash = await sha256Hex(enrollmentToken);
		const results: unknown[] = await db.batch([
			db.prepare(
				'DELETE FROM push_subscriptions WHERE endpoint = ? AND EXISTS (SELECT 1 FROM push_enrollment_tokens WHERE token_hash = ? AND expires_at > ?)'
			).bind(endpoint, tokenHash, now),
			db.prepare(
				'INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, device_name) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM push_enrollment_tokens WHERE token_hash = ? AND expires_at > ?)'
			).bind(id, endpoint, p256dh, auth, deviceName, tokenHash, now),
			db.prepare('DELETE FROM push_enrollment_tokens WHERE token_hash = ? AND expires_at > ?')
				.bind(tokenHash, now),
		]);

		if (changedRows(results[1]) !== 1 || changedRows(results[2]) !== 1) {
			return corsResponse({ error: 'Invalid or expired enrollment token' }, 401);
		}

		return corsResponse({ id });
	}

	await db.batch([
		db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint),
		db.prepare(
			'INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, device_name) VALUES (?, ?, ?, ?, ?)'
		).bind(id, endpoint, p256dh, auth, deviceName),
	]);

	return corsResponse({ id });
}

export async function handleUnsubscribe(request: Request, db: D1Database): Promise<Response> {
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
		? db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(id)
		: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint);
	await statement.run();
	return corsResponse({ success: true });
}

export async function handleListSubscriptions(db: D1Database): Promise<Response> {
	const rows = await queryRows(
		db.prepare('SELECT id, device_name, created_at FROM push_subscriptions ORDER BY created_at DESC')
	);
	return corsResponse({ subscriptions: rows });
}

export async function handleTestPush(db: D1Database): Promise<Response> {
	const result = await sendToAllSubscriptions(db, {
		title: 'Crate Test',
		body: 'If you see this, push notifications are working!',
		tag: 'crate-test',
	});
	return corsResponse(result);
}
