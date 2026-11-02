import { handleDiagnostics } from '../maintenance/diagnostics';
import { handleHealth } from '../sync/index';
import { handleFeaturePolicy } from '../feature-policy';
import { handleLinkTitle } from '../link-title';
import { corsResponse } from '../cors';
import type { Env } from '../types';
import type { AuthenticatedRouteContext } from '../router';

/** Server status, feature state and link titles for connected clients. */
export async function handleServerRoute(
	request: Request,
	env: Env,
	{ path, method, principal }: Pick<AuthenticatedRouteContext, 'path' | 'method' | 'principal'>,
): Promise<Response | null> {
	if (path === '/features' && ['GET', 'POST'].includes(method)) return handleFeaturePolicy(request, env.DB);
	if (path === '/links/title' && method === 'POST') {
		if (env.NOTIFICATION_REQUEST_LIMITER && !(await env.NOTIFICATION_REQUEST_LIMITER.limit({ key: `link-titles:${principal.tokenId}` })).success) {
			return corsResponse({ title: null }, 429, { 'Retry-After': '60' });
		}
		return handleLinkTitle(request, env.READING_FETCH);
	}
	if (path === '/health' && method === 'GET') return await handleHealth();
	if (path === '/diagnostics' && method === 'GET') return await handleDiagnostics(env.DB);

	return null;
}
