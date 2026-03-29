import { corsHeaders, corsResponse } from './cors';
import { initDb, queryRows } from './db';
import { getOrCreateVapidKeys, sendToAllSubscriptions } from './push';
import { PWA_HTML, SERVICE_WORKER_JS, MANIFEST_JSON, ICON_SVG, OPEN_OBSIDIAN_HTML } from './pwa';
import { parseJsonObject, parseOptionalString } from './utils';

export function handleNotificationsPage(url: URL): Response {
	return new Response(PWA_HTML, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
			'Referrer-Policy': 'no-referrer',
			...corsHeaders(),
		},
	});
}

export function handleServiceWorker(): Response {
	return new Response(SERVICE_WORKER_JS, {
		headers: {
			'Content-Type': 'application/javascript',
			'Service-Worker-Allowed': '/notifications',
			...corsHeaders(),
		},
	});
}

export function handleManifest(): Response {
	return new Response(MANIFEST_JSON, {
		headers: {
			'Content-Type': 'application/manifest+json',
			...corsHeaders(),
		},
	});
}

export function handleOpenObsidian(): Response {
	return new Response(OPEN_OBSIDIAN_HTML, {
		headers: { 'Content-Type': 'text/html; charset=utf-8' },
	});
}

export function handleIcon(): Response {
	return new Response(ICON_SVG, {
		headers: {
			'Content-Type': 'image/svg+xml',
			'Cache-Control': 'public, max-age=86400',
			...corsHeaders(),
		},
	});
}

export async function handleVapidPublicKey(db: D1Database | null): Promise<Response> {
	if (!db) return corsResponse({ error: 'Database not available' }, 404);
	const keys = await getOrCreateVapidKeys(db);
	return corsResponse({ publicKey: keys.publicKey });
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
