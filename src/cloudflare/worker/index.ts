import { corsHeaders, corsResponse } from './cors';
import { authenticateWorkerRequest } from './auth/index';
import { handleAuthenticatedRoute, handlePublicRoute } from './router';
import type { Env } from './types';
import { FileVersionConflictError } from './storage/index';
import { runScheduledMaintenance } from './maintenance';

export { ReminderAlarm } from './notifications';

function withRequestId(response: Response, requestId: string): Response {
	const headers = new Headers(response.headers);
	headers.set('X-Crate-Request-Id', requestId);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const requestId = crypto.randomUUID();
		if (request.method === 'OPTIONS') {
			return withRequestId(new Response(null, { status: 204, headers: corsHeaders() }), requestId);
		}

		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;
		const db = env.DB;

		try {
			const publicResponse = await handlePublicRoute(request, env, path, method);
			if (publicResponse) {
				return withRequestId(publicResponse, requestId);
			}

			const authResult = await authenticateWorkerRequest(request, db);
			if (authResult.response) {
				return withRequestId(authResult.response, requestId);
			}

			const response = await handleAuthenticatedRoute(request, env, path, method, authResult.principal)
				?? corsResponse({ error: 'Not found' }, 404);
			return withRequestId(response, requestId);
		} catch (error) {
			if (error instanceof FileVersionConflictError) {
				return withRequestId(corsResponse({
					error: 'The reminder file changed. Refresh and retry your edit.',
					path: error.path,
					currentHash: error.currentHash,
				}, 409), requestId);
			}
			console.error('Unhandled worker request error', {
				method,
				path,
				requestId,
				error: error instanceof Error ? error.message : String(error),
			});
			return withRequestId(corsResponse({ error: 'Internal server error' }, 500), requestId);
		}
	},
	async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
		await runScheduledMaintenance(env);
	},
};
