import { parseJsonObject } from './utils';
import { handleAuthRoute } from './routes/auth';
import { handleNotificationsRoute } from './routes/notifications';
import { handlePublicRoute } from './routes/public';
import { handleRemindersRoute } from './routes/reminders';
import { handleSyncRoute } from './routes/sync';
import type { RouteMethod } from './routes/shared';
import type { Env } from './types';
import type { AuthPrincipal } from './auth/index';
import { corsResponse } from './cors';

export { handlePublicRoute };

const REMINDERS_SCOPE_ROUTES = new Set([
	'GET /health',
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

export function isAuthenticatedRouteAllowed(
	principal: AuthPrincipal,
	path: string,
	method: RouteMethod,
): boolean {
	return principal.scope === 'vault' || REMINDERS_SCOPE_ROUTES.has(`${method} ${path}`);
}

export async function handleAuthenticatedRoute(
	request: Request,
	env: Env,
	path: string,
	method: RouteMethod,
	principal: AuthPrincipal,
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
	const db = env.DB;

	return await handleSyncRoute(request, env, path, method)
		?? await handleAuthRoute(request, env, path, method)
		?? await handleRemindersRoute(request, env, path, method)
		?? await handleNotificationsRoute(request, db, path, method, principal);
}
