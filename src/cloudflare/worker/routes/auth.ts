import { handleListTokens, handleRegisterToken, handleRevokeToken } from '../auth-handlers';
import type { RouteMethod } from './shared';
import { withDatabase } from './shared';

export async function handleAuthRoute(
	request: Request,
	db: D1Database | null,
	path: string,
	method: RouteMethod,
): Promise<Response | null> {
	if (path === '/auth/tokens' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleRegisterToken(request, requiredDb));
	}
	if (path === '/auth/tokens' && method === 'DELETE') {
		return await withDatabase(db, requiredDb => handleRevokeToken(request, requiredDb));
	}
	if (path === '/auth/tokens' && method === 'GET') {
		return await withDatabase(db, requiredDb => handleListTokens(request, requiredDb));
	}

	return null;
}
