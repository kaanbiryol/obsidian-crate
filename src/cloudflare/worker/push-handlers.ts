import { corsHeaders, corsResponse } from './cors';
import { initDb, queryRows } from './db';
import { getOrCreateVapidKeys, sendToAllSubscriptions } from './push';
import { PWA_HTML, SERVICE_WORKER_JS, MANIFEST_JSON, ICON_SVG } from './pwa';

export function handleNotificationsPage(url: URL): Response {
	return new Response(PWA_HTML, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
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
	const body = await request.json() as {
		endpoint?: string;
		keys?: { p256dh?: string; auth?: string };
		deviceName?: string;
	};

	if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
		return corsResponse({ error: 'endpoint and keys (p256dh, auth) required' }, 400);
	}

	const id = crypto.randomUUID();
	await db.prepare(
		'INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, device_name) VALUES (?, ?, ?, ?, ?)'
	).bind(id, body.endpoint, body.keys.p256dh, body.keys.auth, body.deviceName || null).run();

	return corsResponse({ id });
}

export async function handleUnsubscribe(request: Request, db: D1Database): Promise<Response> {
	await initDb(db);
	const body = await request.json() as { id?: string };
	if (!body.id) return corsResponse({ error: 'id required' }, 400);

	await db.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(body.id).run();
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
