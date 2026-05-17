import { corsHeaders, corsResponse } from './cors';
import { initDb } from './db';
import { sha256Hex, timingSafeEqual } from './auth';
import {
	handleHealth, handleCheckChanges, handleGetChanges, handleGetManifest,
	handleUpload, handleDownload, handleDelete,
	handleBatchUpload, handleBatchDownload, handleBatchDelete,
	handleGetConfig, handleGetSettings, handlePutSettings,
} from './sync-handlers';
import { handleRegisterToken, handleRevokeToken, handleListTokens } from './auth-handlers';
import {
	handleScheduleReminder, handleCancelReminder, handleListScheduled,
} from './reminder-handlers';
import {
	handleCreateReminder,
	handleDeleteReminder,
	handleListReminders,
	handleReorderReminders,
	handleSetReminderCompleted,
	handleUpdateReminder,
} from './reminders-web-handlers';
import {
	handleNotificationsPage, handlePwaApp, handleServiceWorker, handleManifest, handleIcon,
	handleOpenObsidian, handlePwaVersion, handleVapidPublicKey, handleSubscribe, handleUnsubscribe,
	handleListSubscriptions, handleTestPush, handleCreateEnrollmentToken,
	handleCreateRemindersEnrollmentToken, handleExchangeRemindersEnrollmentToken,
} from './push-handlers';
import type { Env } from './types';

export { ReminderAlarm } from './reminder-alarm';

function requireDatabase(db: D1Database | null): D1Database | Response {
	return db ?? corsResponse({ error: 'Database not available' }, 503);
}

function isResponse(value: D1Database | Response): value is Response {
	return value instanceof Response;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders() });
		}

		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;
		const db = env.DB || null;

		// Unauthenticated PWA routes
		if (path === '/notifications' && method === 'GET') return handleNotificationsPage(request);
		if (path === '/notifications/app.js' && method === 'GET') return handlePwaApp(request);
		if (path === '/notifications/sw.js' && method === 'GET') return handleServiceWorker();
		if (path === '/notifications/manifest.json' && method === 'GET') return handleManifest(request);
		if (path === '/notifications/version.json' && method === 'GET') return handlePwaVersion();
		if (path === '/notifications/icon.svg' && method === 'GET') return handleIcon(request);
		if (path === '/notifications/open-obsidian' && method === 'GET') return handleOpenObsidian();
		if (path === '/notifications/vapid-public-key' && method === 'GET') return await handleVapidPublicKey(db);
		if (path === '/notifications/reminders-exchange' && method === 'POST') {
			const requiredDb = requireDatabase(db);
			if (isResponse(requiredDb)) {
				return requiredDb;
			}
			return await handleExchangeRemindersEnrollmentToken(request, requiredDb);
		}

		if (path === '/notifications/subscribe' && method === 'POST') {
			if (request.headers.get('X-Crate-Enrollment-Token')?.trim()) {
				const requiredDb = requireDatabase(db);
				if (isResponse(requiredDb)) {
					return requiredDb;
				}

				try {
					return await handleSubscribe(request, requiredDb);
				} catch {
					return corsResponse({ error: 'Internal server error' }, 500);
				}
			}
		}

		// Auth check
		const authHeader = request.headers.get('Authorization');
		if (!authHeader || !authHeader.startsWith('Bearer ')) {
			return corsResponse({ error: 'Unauthorized' }, 401);
		}
		const token = authHeader.substring(7).trim();
		if (!token) {
			return corsResponse({ error: 'Unauthorized' }, 401);
		}
		const fallbackAuthToken = (env.AUTH_TOKEN ?? '').trim();

		let authenticated = false;
		if (db) {
			try {
				await initDb(db);
				const tokenHash = await sha256Hex(token);
				const row = await db.prepare('SELECT id FROM auth_tokens WHERE token_hash = ?').bind(tokenHash).first<{ id: string }>();
				if (row?.id) {
					authenticated = true;
					await db.prepare(`UPDATE auth_tokens
						SET last_seen_at = datetime('now')
						WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-6 hours'))`)
						.bind(row.id)
						.run();
				}
			} catch { /* D1 failure falls through to binding check */ }
		}
		if (!authenticated && (!fallbackAuthToken || !await timingSafeEqual(token, fallbackAuthToken))) {
			return corsResponse({ error: 'Invalid token' }, 401);
		}

		const bucket = env.BUCKET;

		try {
			// Sync routes
			if (path === '/health' && method === 'GET') return await handleHealth();
			if (path === '/sync/check' && method === 'GET') {
				const requiredDb = requireDatabase(db);
				return isResponse(requiredDb) ? requiredDb : await handleCheckChanges(request, requiredDb);
			}
			if (path === '/sync/changes' && method === 'GET') {
				const requiredDb = requireDatabase(db);
				return isResponse(requiredDb) ? requiredDb : await handleGetChanges(request, requiredDb);
			}
			if (path === '/sync/manifest' && method === 'GET') {
				const requiredDb = requireDatabase(db);
				return isResponse(requiredDb) ? requiredDb : await handleGetManifest(request, requiredDb);
			}
			if (path === '/sync/upload' && method === 'PUT') return await handleUpload(request, bucket, db);
			if (path === '/sync/download' && method === 'GET') return await handleDownload(request, bucket, db);
			if (path === '/sync/delete' && method === 'POST') return await handleDelete(request, bucket, db);
			if (path === '/sync/batch-upload' && method === 'POST') return await handleBatchUpload(request, bucket, db);
			if (path === '/sync/batch-download' && method === 'POST') return await handleBatchDownload(request, bucket, db);
			if (path === '/sync/batch-delete' && method === 'POST') return await handleBatchDelete(request, bucket, db);
			if (path === '/sync/config' && method === 'GET') return await handleGetConfig(env);

			// Auth token routes
			if (path === '/auth/tokens' && (method === 'POST' || method === 'DELETE' || method === 'GET')) {
				const requiredDb = requireDatabase(db);
				if (isResponse(requiredDb)) {
					return requiredDb;
				}

				if (method === 'POST') return await handleRegisterToken(request, requiredDb);
				if (method === 'DELETE') return await handleRevokeToken(request, requiredDb);
				return await handleListTokens(request, requiredDb);
			}

			// Settings routes
			if (path === '/settings' && method === 'GET') return await handleGetSettings(bucket);
			if (path === '/settings' && method === 'PUT') return await handlePutSettings(request, bucket);

			// Reminder routes
			if (path === '/reminders/list' && method === 'GET') {
				const requiredDb = requireDatabase(db);
				return isResponse(requiredDb) ? requiredDb : await handleListReminders(request, env);
			}
			if (path === '/reminders/create' && method === 'POST') {
				const requiredDb = requireDatabase(db);
				return isResponse(requiredDb) ? requiredDb : await handleCreateReminder(request, env);
			}
			if (path === '/reminders/update' && method === 'POST') {
				const requiredDb = requireDatabase(db);
				return isResponse(requiredDb) ? requiredDb : await handleUpdateReminder(request, env);
			}
			if (path === '/reminders/set-completed' && method === 'POST') {
				const requiredDb = requireDatabase(db);
				return isResponse(requiredDb) ? requiredDb : await handleSetReminderCompleted(request, env);
			}
			if (path === '/reminders/delete' && method === 'DELETE') {
				const requiredDb = requireDatabase(db);
				return isResponse(requiredDb) ? requiredDb : await handleDeleteReminder(request, env);
			}
			if (path === '/reminders/reorder' && method === 'POST') {
				const requiredDb = requireDatabase(db);
				return isResponse(requiredDb) ? requiredDb : await handleReorderReminders(request, env);
			}
			if (path === '/reminders/schedule' && method === 'POST') return await handleScheduleReminder(request, env);
			if (path === '/reminders/cancel' && method === 'DELETE') return await handleCancelReminder(request, env);
			if (path === '/reminders/scheduled' && method === 'GET') {
				const requiredDb = requireDatabase(db);
				return isResponse(requiredDb) ? requiredDb : await handleListScheduled(requiredDb);
			}

			// Push subscription routes (authenticated)
			if (path === '/notifications/subscribe' && (method === 'POST' || method === 'DELETE')) {
				const requiredDb = requireDatabase(db);
				if (isResponse(requiredDb)) {
					return requiredDb;
				}

				return method === 'POST'
					? await handleSubscribe(request, requiredDb)
					: await handleUnsubscribe(request, requiredDb);
			}
			if (path === '/notifications/subscriptions' && method === 'GET') {
				const requiredDb = requireDatabase(db);
				return isResponse(requiredDb) ? requiredDb : await handleListSubscriptions(requiredDb);
			}
			if (path === '/notifications/enrollment-token' && method === 'POST') {
				const requiredDb = requireDatabase(db);
				return isResponse(requiredDb) ? requiredDb : await handleCreateEnrollmentToken(requiredDb);
			}
			if (path === '/notifications/reminders-enrollment-token' && method === 'POST') {
				const requiredDb = requireDatabase(db);
				return isResponse(requiredDb) ? requiredDb : await handleCreateRemindersEnrollmentToken(requiredDb);
			}
			if (path === '/notifications/test' && method === 'POST') {
				const requiredDb = requireDatabase(db);
				return isResponse(requiredDb) ? requiredDb : await handleTestPush(requiredDb);
			}

			return corsResponse({ error: 'Not found' }, 404);
		} catch {
			return corsResponse({ error: 'Internal server error' }, 500);
		}
	},
};
