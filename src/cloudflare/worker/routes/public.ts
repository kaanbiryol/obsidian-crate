import {
	handleExchangeRemindersEnrollmentToken,
	handleVapidPublicKey,
} from '../notification-enrollment-handlers';
import { handleSubscribe } from '../notification-subscription-handlers';
import {
	handleAppleStartup1179x2556,
	handleAppleStartup1206x2622,
	handleAppleStartup1290x2796,
	handleAppleTouchIcon,
	handleCrateIcon192,
	handleCrateIcon512,
	handleCrateMark256,
	handleIcon,
	handleManifest,
	handleNotificationsPage,
	handleOpenObsidian,
	handleOpenObsidianScript,
	handlePwaApp,
	handlePwaThemeBootstrap,
	handlePwaVersion,
	handleServiceWorker,
} from '../pwa/asset-handlers';
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
	const db = env.DB;
	if (path === '/.well-known/crate' && method === 'GET') return handleServerInfo();
	if (path === '/' && method === 'GET') return handleServerInfo();
	if (path === '/notifications' && method === 'GET') return handleNotificationsPage(request);
	if (path === '/notifications/app.js' && method === 'GET') return handlePwaApp(request);
	if (path === '/notifications/theme-bootstrap.js' && method === 'GET') return handlePwaThemeBootstrap(request);
	if (path === '/notifications/sw.js' && method === 'GET') return handleServiceWorker();
	if (path === '/notifications/manifest.json' && method === 'GET') return handleManifest(request);
	if (path === '/notifications/version.json' && method === 'GET') return handlePwaVersion();
	if (path === '/notifications/icon.svg' && method === 'GET') return handleIcon(request);
	if (path === '/notifications/crate-icon-192.png' && method === 'GET') return handleCrateIcon192(request);
	if (path === '/notifications/crate-icon-512.png' && method === 'GET') return handleCrateIcon512(request);
	if (path === '/notifications/crate-mark-256.png' && method === 'GET') return handleCrateMark256(request);
	if (path === '/notifications/apple-touch-icon-180.png' && method === 'GET') return handleAppleTouchIcon(request);
	if (path === '/notifications/apple-startup-1179x2556.png' && method === 'GET') return handleAppleStartup1179x2556(request);
	if (path === '/notifications/apple-startup-1206x2622.png' && method === 'GET') return handleAppleStartup1206x2622(request);
	if (path === '/notifications/apple-startup-1290x2796.png' && method === 'GET') return handleAppleStartup1290x2796(request);
	if (path === '/notifications/open-obsidian' && method === 'GET') return handleOpenObsidian();
	if (path === '/notifications/open-obsidian.js' && method === 'GET') return handleOpenObsidianScript(request);
	if (path === '/notifications/vapid-public-key' && method === 'GET') return await handleVapidPublicKey(db);
	if (path === '/notifications/reminders-exchange' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleExchangeRemindersEnrollmentToken(request, requiredDb));
	}

	if (
		path === '/notifications/subscribe'
		&& method === 'POST'
		&& request.headers.get('X-Crate-Enrollment-Token')?.trim()
	) {
		return await withDatabase(db, requiredDb => handleSubscribe(request, requiredDb));
	}

	return null;
}
