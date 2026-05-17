import { corsResponse } from './cors';
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

type RouteMethod = Request['method'];

function requireDatabase(db: D1Database | null): D1Database | Response {
	return db ?? corsResponse({ error: 'Database not available' }, 503);
}

function isResponse(value: D1Database | Response): value is Response {
	return value instanceof Response;
}

async function withDatabase(
	db: D1Database | null,
	handler: (db: D1Database) => Promise<Response>,
): Promise<Response> {
	const requiredDb = requireDatabase(db);
	return isResponse(requiredDb) ? requiredDb : handler(requiredDb);
}

export async function handlePublicRoute(
	request: Request,
	path: string,
	method: RouteMethod,
	db: D1Database | null,
): Promise<Response | null> {
	if (path === '/notifications' && method === 'GET') return handleNotificationsPage(request);
	if (path === '/notifications/app.js' && method === 'GET') return handlePwaApp(request);
	if (path === '/notifications/sw.js' && method === 'GET') return handleServiceWorker();
	if (path === '/notifications/manifest.json' && method === 'GET') return handleManifest(request);
	if (path === '/notifications/version.json' && method === 'GET') return handlePwaVersion();
	if (path === '/notifications/icon.svg' && method === 'GET') return handleIcon(request);
	if (path === '/notifications/open-obsidian' && method === 'GET') return handleOpenObsidian();
	if (path === '/notifications/vapid-public-key' && method === 'GET') return await handleVapidPublicKey(db);
	if (path === '/notifications/reminders-exchange' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleExchangeRemindersEnrollmentToken(request, requiredDb));
	}

	if (
		path === '/notifications/subscribe'
		&& method === 'POST'
		&& request.headers.get('X-Crate-Enrollment-Token')?.trim()
	) {
		try {
			return await withDatabase(db, requiredDb => handleSubscribe(request, requiredDb));
		} catch {
			return corsResponse({ error: 'Internal server error' }, 500);
		}
	}

	return null;
}

export async function handleAuthenticatedRoute(
	request: Request,
	env: Env,
	path: string,
	method: RouteMethod,
): Promise<Response | null> {
	const db = env.DB || null;
	const bucket = env.BUCKET;

	if (path === '/health' && method === 'GET') return await handleHealth();
	if (path === '/sync/check' && method === 'GET') {
		return await withDatabase(db, requiredDb => handleCheckChanges(request, requiredDb));
	}
	if (path === '/sync/changes' && method === 'GET') {
		return await withDatabase(db, requiredDb => handleGetChanges(request, requiredDb));
	}
	if (path === '/sync/manifest' && method === 'GET') {
		return await withDatabase(db, requiredDb => handleGetManifest(request, requiredDb));
	}
	if (path === '/sync/upload' && method === 'PUT') return await handleUpload(request, bucket, db);
	if (path === '/sync/download' && method === 'GET') return await handleDownload(request, bucket, db);
	if (path === '/sync/delete' && method === 'POST') return await handleDelete(request, bucket, db);
	if (path === '/sync/batch-upload' && method === 'POST') return await handleBatchUpload(request, bucket, db);
	if (path === '/sync/batch-download' && method === 'POST') return await handleBatchDownload(request, bucket, db);
	if (path === '/sync/batch-delete' && method === 'POST') return await handleBatchDelete(request, bucket, db);
	if (path === '/sync/config' && method === 'GET') return await handleGetConfig(env);

	if (path === '/auth/tokens' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleRegisterToken(request, requiredDb));
	}
	if (path === '/auth/tokens' && method === 'DELETE') {
		return await withDatabase(db, requiredDb => handleRevokeToken(request, requiredDb));
	}
	if (path === '/auth/tokens' && method === 'GET') {
		return await withDatabase(db, requiredDb => handleListTokens(request, requiredDb));
	}

	if (path === '/settings' && method === 'GET') return await handleGetSettings(bucket);
	if (path === '/settings' && method === 'PUT') return await handlePutSettings(request, bucket);

	if (path === '/reminders/list' && method === 'GET') {
		return await withDatabase(db, () => handleListReminders(request, env));
	}
	if (path === '/reminders/create' && method === 'POST') {
		return await withDatabase(db, () => handleCreateReminder(request, env));
	}
	if (path === '/reminders/update' && method === 'POST') {
		return await withDatabase(db, () => handleUpdateReminder(request, env));
	}
	if (path === '/reminders/set-completed' && method === 'POST') {
		return await withDatabase(db, () => handleSetReminderCompleted(request, env));
	}
	if (path === '/reminders/delete' && method === 'DELETE') {
		return await withDatabase(db, () => handleDeleteReminder(request, env));
	}
	if (path === '/reminders/reorder' && method === 'POST') {
		return await withDatabase(db, () => handleReorderReminders(request, env));
	}
	if (path === '/reminders/schedule' && method === 'POST') return await handleScheduleReminder(request, env);
	if (path === '/reminders/cancel' && method === 'DELETE') return await handleCancelReminder(request, env);
	if (path === '/reminders/scheduled' && method === 'GET') {
		return await withDatabase(db, requiredDb => handleListScheduled(requiredDb));
	}

	if (path === '/notifications/subscribe' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleSubscribe(request, requiredDb));
	}
	if (path === '/notifications/subscribe' && method === 'DELETE') {
		return await withDatabase(db, requiredDb => handleUnsubscribe(request, requiredDb));
	}
	if (path === '/notifications/subscriptions' && method === 'GET') {
		return await withDatabase(db, requiredDb => handleListSubscriptions(requiredDb));
	}
	if (path === '/notifications/enrollment-token' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleCreateEnrollmentToken(requiredDb));
	}
	if (path === '/notifications/reminders-enrollment-token' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleCreateRemindersEnrollmentToken(requiredDb));
	}
	if (path === '/notifications/test' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleTestPush(requiredDb));
	}

	return null;
}
