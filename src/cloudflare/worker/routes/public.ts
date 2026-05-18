import { corsResponse } from '../cors';
import {
	handleExchangeRemindersEnrollmentToken,
	handleIcon,
	handleManifest,
	handleNotificationsPage,
	handleOpenObsidian,
	handlePwaApp,
	handlePwaVersion,
	handleServiceWorker,
	handleSubscribe,
	handleVapidPublicKey,
} from '../push-handlers';
import type { RouteMethod } from './shared';
import { withDatabase } from './shared';

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
