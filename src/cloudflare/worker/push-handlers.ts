import { corsHeaders, corsResponse } from './cors';
import { sha256Hex } from './auth';
import { initDb, queryRows } from './db';
import { getOrCreateVapidKeys, sendToAllSubscriptions } from './push';
import { issuePushEnrollmentToken, purgeExpiredPushEnrollmentTokens } from './push-enrollment';
import { consumeWebEnrollmentToken, issueWebEnrollmentToken } from './web-enrollment';
import {
	APPLE_STARTUP_1179X2556_PNG,
	APPLE_STARTUP_1206X2622_PNG,
	APPLE_STARTUP_1290X2796_PNG,
	APPLE_TOUCH_ICON_180_PNG,
	CRATE_ICON_192_PNG,
	CRATE_ICON_512_PNG,
	CRATE_MARK_256_PNG,
	PWA_APP_JS,
	SERVICE_WORKER_JS,
	ICON_SVG,
	OPEN_OBSIDIAN_HTML,
	createManifestJson,
	createPwaHtml,
	createPwaVersionJson,
} from './pwa';
import { parseJsonObject, parseOptionalString } from './utils';

interface D1MutationResult {
	meta?: {
		changes?: number;
	};
}

function isValidPushEndpoint(endpoint: string): boolean {
	try {
		return new URL(endpoint).protocol === 'https:';
	} catch {
		return false;
	}
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
			"script-src 'self'",
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

function versionedAssetHeaders(request: Request): Record<string, string> {
	const version = new URL(request.url).searchParams.get('v')?.trim();
	return {
		'Cache-Control': version ? 'public, max-age=31536000, immutable' : 'no-store',
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
	};
}

export function handleNotificationsPage(request: Request): Response {
	return new Response(createPwaHtml(request.url), {
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

export function handlePwaApp(request: Request): Response {
	return new Response(PWA_APP_JS, {
		headers: {
			'Content-Type': 'application/javascript; charset=utf-8',
			...versionedAssetHeaders(request),
			...corsHeaders(),
		},
	});
}

export function handleManifest(request: Request): Response {
	return new Response(createManifestJson(request.url), {
		headers: {
			'Content-Type': 'application/manifest+json',
			...staticAssetHeaders(),
			...corsHeaders(),
		},
	});
}

export function handlePwaVersion(): Response {
	return new Response(createPwaVersionJson(), {
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
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

export function handleIcon(request: Request): Response {
	return new Response(ICON_SVG, {
		headers: {
			'Content-Type': 'image/svg+xml',
			...versionedAssetHeaders(request),
			...corsHeaders(),
		},
	});
}

function pngAssetResponse(request: Request, asset: Uint8Array): Response {
	return new Response(asset, {
		headers: {
			'Content-Type': 'image/png',
			...versionedAssetHeaders(request),
			...corsHeaders(),
		},
	});
}

export function handleAppleTouchIcon(request: Request): Response {
	return pngAssetResponse(request, APPLE_TOUCH_ICON_180_PNG);
}

export function handleAppleStartup1179x2556(request: Request): Response {
	return pngAssetResponse(request, APPLE_STARTUP_1179X2556_PNG);
}

export function handleAppleStartup1206x2622(request: Request): Response {
	return pngAssetResponse(request, APPLE_STARTUP_1206X2622_PNG);
}

export function handleAppleStartup1290x2796(request: Request): Response {
	return pngAssetResponse(request, APPLE_STARTUP_1290X2796_PNG);
}

export function handleCrateIcon192(request: Request): Response {
	return pngAssetResponse(request, CRATE_ICON_192_PNG);
}

export function handleCrateIcon512(request: Request): Response {
	return pngAssetResponse(request, CRATE_ICON_512_PNG);
}

export function handleCrateMark256(request: Request): Response {
	return pngAssetResponse(request, CRATE_MARK_256_PNG);
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

function createBearerToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const REMINDERS_AUTH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export async function handleCreateRemindersEnrollmentToken(db: D1Database): Promise<Response> {
	await initDb(db);
	const { token, expiresAt } = await issueWebEnrollmentToken(db);
	return corsResponse({
		token,
		expiresAt: new Date(expiresAt).toISOString(),
	});
}

export async function handleExchangeRemindersEnrollmentToken(request: Request, db: D1Database): Promise<Response> {
	await initDb(db);
	const parsedBody = await parseJsonObject(request);
	if (!parsedBody.ok) {
		return parsedBody.response;
	}

	const token = parseOptionalString(parsedBody.value.token, 128);
	const deviceName = parseOptionalString(parsedBody.value.deviceName, 128) || 'Reminders web app';
	if (!token) {
		return corsResponse({ error: 'token required' }, 400);
	}

	const consumed = await consumeWebEnrollmentToken(db, token);
	if (!consumed) {
		return corsResponse({ error: 'Invalid or expired enrollment token' }, 401);
	}

	const authToken = createBearerToken();
	const tokenHash = await sha256Hex(authToken);
	const id = crypto.randomUUID();

	const expiresAt = Date.now() + REMINDERS_AUTH_TOKEN_TTL_MS;
	await db.prepare(`INSERT INTO auth_tokens
		(id, token_hash, device_id, device_name, platform, last_seen_at, scope, expires_at)
		VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?)`)
		.bind(id, tokenHash, null, deviceName, 'pwa', 'reminders', expiresAt)
		.run();

	return corsResponse({ authToken, expiresAt: new Date(expiresAt).toISOString() });
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
				db.prepare('DELETE FROM push_enrollment_tokens WHERE token_hash = ? AND expires_at > ?').bind(tokenHash, now),
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
	await initDb(db);
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
