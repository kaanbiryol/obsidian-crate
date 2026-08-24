import { corsResponse } from '../cors';
import {
	handleExchangeRemindersEnrollmentToken,
	handleAppleStartup1179x2556,
	handleAppleStartup1290x2796,
	handleAppleTouchIcon,
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
import { handleServerInfo } from '../server-info';
import type { Env } from '../types';
import type { RouteMethod } from './shared';
import { withDatabase } from './shared';

export async function handlePublicRoute(
	request: Request,
	env: Env,
	path: string,
	method: RouteMethod,
): Promise<Response | null> {
	const db = env.DB || null;
	if (path === '/.well-known/crate' && method === 'GET') return handleServerInfo();
	if (path === '/' && method === 'GET') return handleServerInfo();
	if (path === '/notifications' && method === 'GET') return handleNotificationsPage(request);
	if (path === '/notifications/app.js' && method === 'GET') return handlePwaApp(request);
	if (path === '/notifications/sw.js' && method === 'GET') return handleServiceWorker();
	if (path === '/notifications/manifest.json' && method === 'GET') return handleManifest(request);
	if (path === '/notifications/version.json' && method === 'GET') return handlePwaVersion();
	if (path === '/notifications/icon.svg' && method === 'GET') return handleIcon(request);
	if (path === '/notifications/apple-touch-icon-180.png' && method === 'GET') return handleAppleTouchIcon(request);
	if (path === '/notifications/apple-startup-1179x2556.png' && method === 'GET') return handleAppleStartup1179x2556(request);
	if (path === '/notifications/apple-startup-1290x2796.png' && method === 'GET') return handleAppleStartup1290x2796(request);
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
