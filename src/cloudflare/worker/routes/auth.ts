import {
	handleListTokens,
	handleRevokeCurrentToken,
	handleRevokeToken,
} from '../auth/index';
import type { Env } from '../types';
import type { AuthenticatedRouteContext } from '../router';

export async function handleAuthRoute(
	request: Request,
	env: Env,
	{ path, method, principal }: Pick<AuthenticatedRouteContext, 'path' | 'method' | 'principal'>,
): Promise<Response | null> {
	const db = env.DB;
	if (path === '/auth/tokens' && method === 'DELETE') {
		return await handleRevokeToken(request, db);
	}
	if (path === '/auth/tokens' && method === 'GET') {
		return await handleListTokens(db, principal.tokenId);
	}
	if (path === '/auth/session' && method === 'DELETE') {
		return await handleRevokeCurrentToken(request, db);
	}

	return null;
}
