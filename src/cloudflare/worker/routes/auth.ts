import {
	handleListTokens,
	handleRevokeCurrentToken,
	handleRevokeToken,
} from '../auth-handlers';
import type { Env } from '../types';
import type { RouteMethod } from './shared';
import { withDatabase } from './shared';

export async function handleAuthRoute(
	request: Request,
	env: Env,
	path: string,
	method: RouteMethod,
): Promise<Response | null> {
	const db = env.DB || null;
	if (path === '/auth/tokens' && method === 'DELETE') {
		return await withDatabase(db, requiredDb => handleRevokeToken(request, requiredDb));
	}
	if (path === '/auth/tokens' && method === 'GET') {
		return await withDatabase(db, requiredDb => handleListTokens(request, requiredDb));
	}
	if (path === '/auth/session' && method === 'DELETE') {
		return await withDatabase(db, requiredDb => handleRevokeCurrentToken(request, requiredDb));
	}

	return null;
}
