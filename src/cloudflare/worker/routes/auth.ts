import {
	handleListTokens,
	handleRegisterToken,
	handleRevokeCurrentToken,
	handleRevokeToken,
} from '../auth-handlers';
import type { Env } from '../types';
import type { RouteMethod } from './shared';
import { withDatabase } from './shared';

async function authorizeDeviceEnrollment(request: Request, env: Env): Promise<Response> {
	const id = env.SETUP.idFromName('owner');
	const internalRequest = new Request('https://crate.internal/setup/authorize-enrollment', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: await request.text(),
	});
	return await env.SETUP.get(id).fetch(internalRequest);
}

export async function handleAuthRoute(
	request: Request,
	env: Env,
	path: string,
	method: RouteMethod,
): Promise<Response | null> {
	const db = env.DB || null;
	if (path === '/auth/enrollment' && method === 'POST') {
		return await authorizeDeviceEnrollment(request, env);
	}
	if (path === '/auth/tokens' && method === 'POST') {
		return await withDatabase(db, requiredDb => handleRegisterToken(request, requiredDb));
	}
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
