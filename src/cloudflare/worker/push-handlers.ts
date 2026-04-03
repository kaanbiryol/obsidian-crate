import { corsHeaders, corsResponse } from './cors';
import { sha256Hex } from './auth';
import { initDb, queryRows } from './db';
import { getOrCreateVapidKeys, sendToAllSubscriptions } from './push';
import { issuePushEnrollmentToken, purgeExpiredPushEnrollmentTokens } from './push-enrollment';
import { PWA_HTML, SERVICE_WORKER_JS, MANIFEST_JSON, ICON_SVG, OPEN_OBSIDIAN_HTML } from './pwa';
import { parseJsonObject, parseOptionalString } from './utils';

interface D1MutationResult {
	meta?: {
		changes?: number;
	};
}

function changedRows(result: unknown): number {
	if (!result || typeof result !== 'object') {
		return 0;
	}

	const changes = (result as D1MutationResult).meta?.changes;
	return typeof changes === 'number' ? changes : 0;
}

function htmlSecurityHeaders(): Record<string, string> {
	return {
		'Cache-Control': 'no-store',
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
		'X-Frame-Options': 'DENY',
		'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
		'Content-Security-Policy': [
			"default-src 'none'",
			"style-src 'unsafe-inline'",
			"script-src 'unsafe-inline'",
			"connect-src 'self'",
			"img-src 'self' data:",
			"manifest-src 'self'",
			"base-uri 'none'",
			"form-action 'none'",
			"frame-ancestors 'none'",
		].join('; '),
	};
}

function staticAssetHeaders(): Record<string, string> {
	return {
		'Cache-Control': 'no-store',
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
	};
}

export function handleNotificationsPage(): Response {
	return new Response(PWA_HTML, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			...htmlSecurityHeaders(),
			...corsHeaders(),
		},
	});
}

export function handleServiceWorker(): Response {
	return new Response(SERVICE_WORKER_JS, {
		headers: {
			'Content-Type': 'application/javascript',
			'Service-Worker-Allowed': '/notifications',
			...staticAssetHeaders(),
			...corsHeaders(),
		},
	});
}

export function handleManifest(): Response {
	return new Response(MANIFEST_JSON, {
		headers: {
			'Content-Type': 'application/manifest+json',
			...staticAssetHeaders(),
			...corsHeaders(),
		},
	});
}

export function handleOpenObsidian(): Response {
	return new Response(OPEN_OBSIDIAN_HTML, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			...htmlSecurityHeaders(),
		},
	});
}

export function handleIcon(): Response {
	return new Response(ICON_SVG, {
		headers: {
			'Content-Type': 'image/svg+xml',
			'Cache-Control': 'public, max-age=86400',
			'X-Content-Type-Options': 'nosniff',
			...corsHeaders(),
		},
	});
}

export async function handleVapidPublicKey(db: D1Database | null): Promise<Response> {
	if (!db) return corsResponse({ error: 'Database not available' }, 404);
	const keys = await getOrCreateVapidKeys(db);
	return corsResponse({ publicKey: keys.publicKey });
}

export async function handleCreateEnrollmentToken(db: D1Database): Promise<Response> {
	await initDb(db);
	const { token, expiresAt } = await issuePushEnrollmentToken(db);
	return corsResponse({
		token,
		expiresAt: new Date(expiresAt).toISOString(),
	});
}

export async function handleSubscribe(request: Request, db: D1Database): Promise<Response> {
	await initDb(db);
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const endpoint = parseOptionalString(parsedBody.value.endpoint, 2048);
	const keys = parsedBody.value.keys;
	const p256dh = keys && typeof keys === 'object' ? parseOptionalString((keys as Record<string, unknown>).p256dh, 512) : null;
	const auth = keys && typeof keys === 'object' ? parseOptionalString((keys as Record<string, unknown>).auth, 512) : null;
	const deviceName = parsedBody.value.deviceName === undefined
		? null
		: parseOptionalString(parsedBody.value.deviceName, 128);

	if (!endpoint || !p256dh || !auth) {
		return corsResponse({ error: 'endpoint and keys (p256dh, auth) required' }, 400);
	}
	if (parsedBody.value.deviceName !== undefined && deviceName === null) {
		return corsResponse({ error: 'Invalid deviceName' }, 400);
	}

	try {
		const url = new URL(endpoint);
		if (url.protocol !== 'https:') {
			return corsResponse({ error: 'Invalid endpoint' }, 400);
		}
	} catch {
		return corsResponse({ error: 'Invalid endpoint' }, 400);
	}

	const id = crypto.randomUUID();
	const enrollmentToken = request.headers.get('X-Crate-Enrollment-Token')?.trim() || '';
	if (enrollmentToken) {
		await purgeExpiredPushEnrollmentTokens(db);
		const now = Date.now();
		const tokenHash = await sha256Hex(enrollmentToken);
		const results = await db.batch([
			db.prepare(
				'DELETE FROM push_subscriptions WHERE endpoint = ? AND EXISTS (SELECT 1 FROM push_enrollment_tokens WHERE token_hash = ? AND expires_at > ?)'
			).bind(endpoint, tokenHash, now),
			db.prepare(
				'INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, device_name) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM push_enrollment_tokens WHERE token_hash = ? AND expires_at > ?)'
			).bind(id, endpoint, p256dh, auth, deviceName, tokenHash, now),
			db.prepare('DELETE FROM push_enrollment_tokens WHERE token_hash = ? AND expires_at > ?').bind(tokenHash, now),
		]) as unknown[];

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
	await initDb(db);
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const id = parseOptionalString(parsedBody.value.id, 128);
	if (!id) return corsResponse({ error: 'id required' }, 400);

	await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(id).run();
	return corsResponse({ success: true });
}

export async function handleListSubscriptions(db: D1Database): Promise<Response> {
	await initDb(db);
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
