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

function requireDatabase(db: D1Database | null): Response | null {
	return db ? null : corsResponse({ error: 'Database not available' }, 503);
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
		if (path === '/notifications/app.js' && method === 'GET') return handlePwaApp();
		if (path === '/notifications/sw.js' && method === 'GET') return handleServiceWorker();
		if (path === '/notifications/manifest.json' && method === 'GET') return handleManifest(request);
		if (path === '/notifications/version.json' && method === 'GET') return handlePwaVersion();
		if (path === '/notifications/icon.svg' && method === 'GET') return handleIcon();
		if (path === '/notifications/open-obsidian' && method === 'GET') return handleOpenObsidian();
		if (path === '/notifications/vapid-public-key' && method === 'GET') return await handleVapidPublicKey(db);
		if (path === '/notifications/reminders-exchange' && method === 'POST') {
			const dbResponse = requireDatabase(db);
			if (dbResponse) {
				return dbResponse;
			}
			return await handleExchangeRemindersEnrollmentToken(request, db);
		}

		if (path === '/notifications/subscribe' && method === 'POST') {
			if (request.headers.get('X-Crate-Enrollment-Token')?.trim()) {
				const dbResponse = requireDatabase(db);
				if (dbResponse) {
					return dbResponse;
				}

				try {
					return await handleSubscribe(request, db);
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
				const dbResponse = requireDatabase(db);
				return dbResponse ?? await handleCheckChanges(request, db);
			}
			if (path === '/sync/changes' && method === 'GET') {
				const dbResponse = requireDatabase(db);
				return dbResponse ?? await handleGetChanges(request, db);
			}
			if (path === '/sync/manifest' && method === 'GET') {
				const dbResponse = requireDatabase(db);
				return dbResponse ?? await handleGetManifest(request, db);
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
				const dbResponse = requireDatabase(db);
				if (dbResponse) {
					return dbResponse;
				}

				if (method === 'POST') return await handleRegisterToken(request, db);
				if (method === 'DELETE') return await handleRevokeToken(request, db);
				return await handleListTokens(request, db);
			}

			// Settings routes
			if (path === '/settings' && method === 'GET') return await handleGetSettings(bucket);
			if (path === '/settings' && method === 'PUT') return await handlePutSettings(request, bucket);

			// Reminder routes
			if (path === '/reminders/list' && method === 'GET') {
				const dbResponse = requireDatabase(db);
				return dbResponse ?? await handleListReminders(request, env);
			}
			if (path === '/reminders/create' && method === 'POST') {
				const dbResponse = requireDatabase(db);
				return dbResponse ?? await handleCreateReminder(request, env);
			}
			if (path === '/reminders/update' && method === 'POST') {
				const dbResponse = requireDatabase(db);
				return dbResponse ?? await handleUpdateReminder(request, env);
			}
			if (path === '/reminders/set-completed' && method === 'POST') {
				const dbResponse = requireDatabase(db);
				return dbResponse ?? await handleSetReminderCompleted(request, env);
			}
			if (path === '/reminders/delete' && method === 'DELETE') {
				const dbResponse = requireDatabase(db);
				return dbResponse ?? await handleDeleteReminder(request, env);
			}
			if (path === '/reminders/reorder' && method === 'POST') {
				const dbResponse = requireDatabase(db);
				return dbResponse ?? await handleReorderReminders(request, env);
			}
			if (path === '/reminders/schedule' && method === 'POST') return await handleScheduleReminder(request, env);
			if (path === '/reminders/cancel' && method === 'DELETE') return await handleCancelReminder(request, env);
			if (path === '/reminders/scheduled' && method === 'GET') {
				const dbResponse = requireDatabase(db);
				return dbResponse ?? await handleListScheduled(db);
			}

			// Push subscription routes (authenticated)
			if (path === '/notifications/subscribe' && (method === 'POST' || method === 'DELETE')) {
				const dbResponse = requireDatabase(db);
				if (dbResponse) {
					return dbResponse;
				}

				return method === 'POST'
					? await handleSubscribe(request, db)
					: await handleUnsubscribe(request, db);
			}
			if (path === '/notifications/subscriptions' && method === 'GET') {
				const dbResponse = requireDatabase(db);
				return dbResponse ?? await handleListSubscriptions(db);
			}
			if (path === '/notifications/enrollment-token' && method === 'POST') {
				const dbResponse = requireDatabase(db);
				return dbResponse ?? await handleCreateEnrollmentToken(db);
			}
			if (path === '/notifications/reminders-enrollment-token' && method === 'POST') {
				const dbResponse = requireDatabase(db);
				return dbResponse ?? await handleCreateRemindersEnrollmentToken(db);
			}
			if (path === '/notifications/test' && method === 'POST') {
				const dbResponse = requireDatabase(db);
				return dbResponse ?? await handleTestPush(db);
			}

			return corsResponse({ error: 'Not found' }, 404);
		} catch {
			return corsResponse({ error: 'Internal server error' }, 500);
		}
	},
};
