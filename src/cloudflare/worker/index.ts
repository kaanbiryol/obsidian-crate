import { corsHeaders, corsResponse } from './cors';
import { authenticateWorkerRequest } from './authenticate';
import { handleAuthenticatedRoute, handlePublicRoute } from './router';
import type { Env } from './types';
import { FileVersionConflictError } from './storage';

export { ReminderAlarm } from './reminder-alarm';
export { SetupCoordinator } from './setup-coordinator';

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders() });
		}

		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;
		const db = env.DB || null;

		const publicResponse = await handlePublicRoute(request, env, path, method);
		if (publicResponse) {
			return publicResponse;
		}

		const authResult = await authenticateWorkerRequest(
			request,
			db,
			(env.AUTH_TOKEN ?? '').trim(),
		);
		if (authResult.response) {
			return authResult.response;
		}

		try {
			return await handleAuthenticatedRoute(request, env, path, method, authResult.principal)
				?? corsResponse({ error: 'Not found' }, 404);
		} catch (error) {
			if (error instanceof FileVersionConflictError) {
				return corsResponse({
					error: 'The reminder file changed. Refresh and retry your edit.',
					path: error.path,
					currentHash: error.currentHash,
				}, 409);
			}
			console.error('Unhandled worker request error', {
				method,
				path,
				error: error instanceof Error ? error.message : String(error),
			});
			return corsResponse({ error: 'Internal server error' }, 500);
		}
	},
};
