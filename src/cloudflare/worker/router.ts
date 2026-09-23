import { handleReadingRoute } from './reading/routes';
import { parseJsonObject } from './utils';
import { limitNotificationAction } from './rate-limit';
import { handleAuthRoute } from './routes/auth';
import { handleNotificationsRoute } from './routes/notifications';
import { handlePublicRoute } from './routes/public';
import { handleRemindersRoute } from './routes/reminders';
import { handleSyncRoute } from './routes/sync';
import type { RouteMethod } from './routes/shared';
import type { Env } from './types';
import type { AuthPrincipal } from './auth/index';
import { corsResponse } from './cors';
import { mutationAuditContext } from './request-diagnostics';
import { handleLinkTitle } from './link-title';

export { handlePublicRoute };

const REMINDERS_SCOPE_ROUTES = new Set([
	'GET /health',
	'POST /links/title',
	'GET /reminders/list',
	'POST /reminders/create',
	'POST /reminders/update',
	'POST /reminders/set-completed',
	'DELETE /reminders/delete',
	'POST /reminders/reorder',
	'POST /notifications/subscribe',
	'DELETE /notifications/subscribe',
	'DELETE /auth/session',
]);

const READING_LIBRARY_ROUTES = new Set([
	'POST /reading/shortcut-pairing',
	'GET /reading/session',
	'GET /reading/list',
	'GET /reading/item',
	'POST /reading/capture',
	'POST /reading/prepare',
	'POST /reading/update',
	'POST /reading/retry',
]);

export function isAuthenticatedRouteAllowed(
	principal: AuthPrincipal,
	path: string,
	method: RouteMethod,
): boolean {
	if (principal.scope === 'vault') return true;
 if (principal.scope === 'reminders') return REMINDERS_SCOPE_ROUTES.has(`${method} ${path}`) || READING_LIBRARY_ROUTES.has(`${method} ${path}`);
 if (principal.scope === 'reading_capture') return ['POST /reading/capture', 'POST /reading/prepare'].includes(`${method} ${path}`);
 if (principal.scope === 'reading') return READING_LIBRARY_ROUTES.has(`${method} ${path}`) || `${method} ${path}` === 'DELETE /auth/session';
 return false;
}

export async function handleAuthenticatedRoute(
	request: Request,
	env: Env,
	path: string,
	method: RouteMethod,
	principal: AuthPrincipal,
	requestId?: string,
): Promise<Response | null> {
	if (!isAuthenticatedRouteAllowed(principal, path, method)) {
		return corsResponse({ error: 'Token is not authorized for this operation' }, 403);
	}

	if (principal.scope === 'reminders' && path.startsWith('/reminders/')) {
		let folder: unknown = new URL(request.url).searchParams.get('folderPath');
		if (method !== 'GET') {
			const parsed = await parseJsonObject(request.clone());
			if (!parsed.ok) return parsed.response;
			folder = parsed.value.folderPath;
		}
		if (!principal.folderPath || folder !== principal.folderPath) return corsResponse({ error: 'This session is limited to its enrolled reminders folder' }, 403);
	}
	if (path.startsWith('/reading/')) return handleReadingRoute(request, env, principal);
	const db = env.DB;
	const limited = await limitNotificationAction(request, db, principal.tokenId);
	if (limited) return limited;
	if (path === '/links/title' && method === 'POST') {
		if (env.NOTIFICATION_REQUEST_LIMITER && !(await env.NOTIFICATION_REQUEST_LIMITER.limit({ key: `link-titles:${principal.tokenId}` })).success) {
			return corsResponse({ title: null }, 429, { 'Retry-After': '60' });
		}
		return handleLinkTitle(request);
	}

	return await handleSyncRoute(request, env, path, method, mutationAuditContext(request, principal, requestId))
		?? await handleAuthRoute(request, env, path, method)
		?? await handleRemindersRoute(request, env, path, method)
		?? await handleNotificationsRoute(request, db, path, method, principal);
}
