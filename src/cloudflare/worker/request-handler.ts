import { MarkdownEncodingError } from '@/reminders/core/markdownEncoding';
import { ReminderInputError } from '@/reminders/core/reminderMutationInput';
import { ReminderFileSizeError } from './reminders-web/limits';
import { ReminderIdentityConflictError } from './reminder-source-identity';
import { logMutation } from './request-diagnostics';
import { limitNotificationRequest } from './rate-limit';
import { coordinatedUpload } from './staged-upload-dispatch';
import { affectsNotifications } from './notification-mutations';
import { armNotificationCoordinator } from './notification-lifecycle';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER, isCrateMutation } from '../../protocol';
import { corsHeaders, corsResponse } from './cors';
import { authenticateWorkerRequest } from './auth/index';
import { handleAuthenticatedRoute, handlePublicRoute, isAuthenticatedRouteAllowed } from './router';
import type { Env } from './types';
import { FileVersionConflictError } from './storage/index';
import { FileNamespaceConflictError } from './file-namespace';
import { ReminderMarkdownContextError } from '@/reminders/core/markdownTaskContext';

function withRequestId(response: Response, requestId: string): Response {
	const headers = new Headers(response.headers);
	headers.set('X-Crate-Request-Id', requestId);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export async function fetchWorkerRequest(request: Request, env: Env, coordinatorState?: DurableObjectState): Promise<Response> {
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
		const rateLimited = coordinatorState ? null : await limitNotificationRequest(request, db, env.NOTIFICATION_REQUEST_LIMITER);
		if (rateLimited) return withRequestId(rateLimited, requestId);
		const publicResponse = await handlePublicRoute(request, env, path, method);
		if (publicResponse) {
			return withRequestId(publicResponse, requestId);
		}

		const authResult = await authenticateWorkerRequest(request, db);
		if (authResult.response) {
			return withRequestId(authResult.response, requestId);
		}

    if (!isAuthenticatedRouteAllowed(authResult.principal, path, method)) return withRequestId(corsResponse({ error: 'Token is not authorized for this operation' }, 403), requestId);
		const mutation = isCrateMutation(path, method);
    const notificationMutation = await affectsNotifications(request);
		if (notificationMutation && !coordinatorState) {
			const stub = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection'));
			const forwarded = new Request(request);
			forwarded.headers.set('X-Crate-Internal-Mutation', '1');
			return await stub.fetch(forwarded);
		}
		if (!mutation && !coordinatorState && ['/sync/check', '/sync/manifest', '/reminders/list'].includes(path)) {
			const stub = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection'));
			const ensured = await stub.fetch('https://do/ensure', { method: 'POST' });
			if (!ensured.ok) throw new Error('Unable to initialize notification processing');
		}
		if (notificationMutation && coordinatorState) await armNotificationCoordinator(coordinatorState);
    if (mutation && !coordinatorState) {
      const maintenance = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/maintenance'));
      const scheduled = await maintenance.fetch('https://do/maintain', { method: 'POST' });
      if (!scheduled.ok) throw new Error('Unable to schedule cleanup');
    }
    const routeEnv = coordinatorState ? env : { ...env, commitUpload: coordinatedUpload(env) };
		const response = await handleAuthenticatedRoute(request, routeEnv, path, method, authResult.principal, requestId)
			?? corsResponse({ error: 'Not found' }, 404);
		if (mutation) await logMutation(request, response, requestId, authResult.principal);
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
}
