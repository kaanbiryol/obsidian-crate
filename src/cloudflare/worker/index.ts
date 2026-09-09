import { MarkdownEncodingError } from '@/reminders/core/markdownEncoding';
import { ReminderInputError } from '@/reminders/core/reminderMutationInput';
import { ReminderFileSizeError } from './reminders-web/limits';
import { ReminderIdentityConflictError } from './reminder-source-identity';
import { logMutation } from './request-diagnostics';
import { limitNotificationRequest } from './rate-limit';
import { wakeNotificationCoordinator } from './notification-coordinator';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER, isCrateMutation } from '../../protocol';
import { corsHeaders, corsResponse } from './cors';
import { authenticateWorkerRequest } from './auth/index';
import { handleAuthenticatedRoute, handlePublicRoute } from './router';
import type { Env } from './types';
import { FileVersionConflictError } from './storage/index';
import { runScheduledMaintenance } from './maintenance';
import { FileNamespaceConflictError } from './file-namespace';
import { ReminderMarkdownContextError } from '@/reminders/core/markdownTaskContext';

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
	async fetch(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
		const requestId = crypto.randomUUID();
		if (request.method === 'OPTIONS') {
			return withRequestId(new Response(null, { status: 204, headers: corsHeaders() }), requestId);
		}

		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;
		const db = env.DB;

		try {
			if (isCrateMutation(path, method)) {
				const protocol = Number(request.headers.get(CRATE_PROTOCOL_HEADER));
				if (!Number.isInteger(protocol) || protocol < CRATE_PLUGIN_PROTOCOL.oldestCompatible || protocol > CRATE_PLUGIN_PROTOCOL.current) {
					return withRequestId(corsResponse({ error: 'Update Crate and reload the web app before making changes.', code: 'protocol_incompatible', protocol: CRATE_PLUGIN_PROTOCOL }, 428), requestId);
				}
			}
			const rateLimited = await limitNotificationRequest(request, db, env.NOTIFICATION_REQUEST_LIMITER);
			if (rateLimited) return withRequestId(rateLimited, requestId);
			const publicResponse = await handlePublicRoute(request, env, path, method);
			if (publicResponse) {
				return withRequestId(publicResponse, requestId);
			}

			const authResult = await authenticateWorkerRequest(request, db);
			if (authResult.response) {
				return withRequestId(authResult.response, requestId);
			}

			const response = await handleAuthenticatedRoute(request, env, path, method, authResult.principal, requestId)
				?? corsResponse({ error: 'Not found' }, 404);
			if (isCrateMutation(path, method)) await logMutation(request, response, requestId, authResult.principal);
			if (response.ok && isCrateMutation(path, method) && context) context.waitUntil(wakeNotificationCoordinator(env).catch(() => undefined));
			return withRequestId(response, requestId);
		} catch (error) {
			if (error instanceof MarkdownEncodingError) return withRequestId(corsResponse({ error: error.message, code: 'unsupported_markdown_encoding' }, 409), requestId);
			if (error instanceof ReminderInputError) return withRequestId(corsResponse({ error: error.message, field: error.field, code: 'invalid_reminder_input' }, 400), requestId);
			if (error instanceof ReminderMarkdownContextError) return withRequestId(corsResponse({ error: error.message, code: 'reminder_markdown_context' }, 409), requestId);
			if (error instanceof FileNamespaceConflictError) return withRequestId(error.toResponse(), requestId);
      if (error instanceof ReminderIdentityConflictError) return withRequestId(corsResponse({ error: error.message, code: 'duplicate_reminder_identity' }, 409), requestId);
      if (error instanceof ReminderFileSizeError) return withRequestId(corsResponse({ error: error.message }, 413), requestId);
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
				errorClass: error instanceof Error ? error.name : 'UnknownError',
			});
			return withRequestId(corsResponse({ error: 'Internal server error' }, 500), requestId);
		}
	},
	async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
		await runScheduledMaintenance(env);
	},
};
