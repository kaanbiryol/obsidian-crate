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
import { handleServerInfo } from '../server-info';
import { handleSetupClient, handleSetupPage } from '../setup-page';
import type { Env } from '../types';
import type { RouteMethod } from './shared';
import { withDatabase } from './shared';

function forwardSetupRequest(request: Request, env: Env): Promise<Response> {
	const id = env.SETUP.idFromName('owner');
	return env.SETUP.get(id).fetch(request);
}

export async function handlePublicRoute(
	request: Request,
	env: Env,
	path: string,
	method: RouteMethod,
): Promise<Response | null> {
	const db = env.DB || null;
	if (path === '/.well-known/crate' && method === 'GET') return handleServerInfo();
	if (path === '/' && method === 'GET') return handleSetupPage();
	if (path === '/setup/client.js' && method === 'GET') return handleSetupClient();
	if (path === '/setup/status' && method === 'GET') return await forwardSetupRequest(request, env);
	if (path === '/setup/claim' && method === 'POST') return await forwardSetupRequest(request, env);
	if (path === '/setup/enroll' && method === 'POST') return await forwardSetupRequest(request, env);
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
