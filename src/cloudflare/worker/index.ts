import { corsHeaders, corsResponse } from './cors';
import { authenticateWorkerRequest } from './authenticate';
import { handleAuthenticatedRoute, handlePublicRoute } from './router';
import type { Env } from './types';

export { ReminderAlarm } from './reminder-alarm';

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders() });
		}

		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;
		const db = env.DB || null;

		const publicResponse = await handlePublicRoute(request, path, method, db);
		if (publicResponse) {
			return publicResponse;
		}

		const authResponse = await authenticateWorkerRequest(
			request,
			db,
			(env.AUTH_TOKEN ?? '').trim(),
		);
		if (authResponse) {
			return authResponse;
		}

		try {
			return await handleAuthenticatedRoute(request, env, path, method)
				?? corsResponse({ error: 'Not found' }, 404);
		} catch {
			return corsResponse({ error: 'Internal server error' }, 500);
		}
	},
};
