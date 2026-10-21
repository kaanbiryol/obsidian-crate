import {
	handleListTokens,
	handleRevokeCurrentToken,
	handleRevokeToken,
} from '../auth/index';
import type { Env } from '../types';

export async function handleAuthRoute(
	request: Request,
	env: Env,
	path: string,
	method: Request['method'],
): Promise<Response | null> {
	const db = env.DB;
	if (path === '/auth/tokens' && method === 'DELETE') {
		return await handleRevokeToken(request, db);
	}
	if (path === '/auth/tokens' && method === 'GET') {
		return await handleListTokens(request, db);
	}
	if (path === '/auth/session' && method === 'DELETE') {
		return await handleRevokeCurrentToken(request, db);
	}

	return null;
}
