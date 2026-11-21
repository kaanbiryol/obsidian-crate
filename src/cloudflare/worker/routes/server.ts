import { handleDiagnostics } from '../maintenance/diagnostics';
import { handleHealth } from '../server/server-info';
import { handleFeaturePolicy } from '../server/feature-policy-handler';
import { handleHistoryRetention } from '../server/history-retention-handler';
import { handleLinkTitle } from '../server/link-title';
import { corsResponse } from '../http/cors';
import { HOST_STATUS_KEY, HOST_STATUS_PATH, parseHostStatus } from '../../../protocol/host-status';
import type { Env } from '../types';
import type { AuthenticatedRouteContext } from '../router';

/** Server status, feature state, history retention and link titles for connected clients. */
export async function handleServerRoute(
	request: Request,
	env: Env,
	{ path, method, principal, featurePolicyValue }: Pick<AuthenticatedRouteContext, 'path' | 'method' | 'principal' | 'featurePolicyValue'>,
): Promise<Response | null> {
	if (path === '/features' && ['GET', 'POST'].includes(method)) return handleFeaturePolicy(request, env, featurePolicyValue);
	if (path === '/history-retention' && ['GET', 'POST'].includes(method)) return handleHistoryRetention(request, env.DB);
	if (path === '/links/title' && method === 'POST') {
		if (env.NOTIFICATION_REQUEST_LIMITER && !(await env.NOTIFICATION_REQUEST_LIMITER.limit({ key: `link-titles:${principal.tokenId}` })).success) {
			return corsResponse({ title: null }, 429, { 'Retry-After': '60' });
		}
		return handleLinkTitle(request, env.READING_FETCH);
	}
	if (path === '/health' && method === 'GET') return await handleHealth();
	if (path === '/diagnostics' && method === 'GET') return await handleDiagnostics(env.DB);
	if (path === HOST_STATUS_PATH && method === 'GET') return await handleHostStatus(env.DB);

	return null;
}

/** A self-hosted server's host process writes its status; a Cloudflare deployment has none. */
async function handleHostStatus(db: D1Database): Promise<Response> {
	const row = await db.prepare('SELECT value FROM maintenance_state WHERE key = ?').bind(HOST_STATUS_KEY).first<{ value: string }>();
	let host = null;
	try { host = row ? parseHostStatus(JSON.parse(row.value)) : null; } catch { /* A malformed record reads as none. */ }
	return corsResponse({ host });
}
