import { handleReadingRoute } from './reading/routes';
import { shortcutCompatibility, shortcutLaunchResponse, shortcutMayBypassWireProtocol, shortcutTransport } from './reading/shortcut-transport';
import { withD1Usage } from './d1-usage';
import { coordinatedNewFiles } from './bulk-upload-dispatch';
import { MarkdownEncodingError } from '@/reminders/core/markdownEncoding';
import { ReminderInputError } from '@/reminders/core/reminderMutationInput';
import { ReminderFileSizeError } from './reminders-web/limits';
import { ReminderIdentityConflictError } from './reminder-source-identity';
import { logMutation } from './request-diagnostics';
import { limitNotificationRequest } from './rate-limit';
import { rememberAuthenticatedRequest } from './admission-state';
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

function withRequestId(response: Response, requestId: string, started: number): Response {
	const headers = new Headers(response.headers);
	headers.set('X-Crate-Request-Id', requestId);
	headers.set('Server-Timing', `crate;dur=${Math.max(0, performance.now() - started).toFixed(2)}`);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

export async function fetchWorkerRequest(request: Request, env: Env, coordinatorState?: DurableObjectState): Promise<Response> {
  const response = await withD1Usage(env, measured => handleWorkerRequest(request, measured, env.DB, coordinatorState));
  return shortcutLaunchResponse(request, response, env.CRATE_DEPLOYMENT_FINGERPRINT);
}

async function handleWorkerRequest(request: Request, env: Env, admissionDb: D1Database, coordinatorState?: DurableObjectState): Promise<Response> {
	const requestId = crypto.randomUUID();
	const started = performance.now();
	if (request.method === 'OPTIONS') {
		return withRequestId(new Response(null, { status: 204, headers: corsHeaders() }), requestId, started);
	}

	const url = new URL(request.url);
	const path = url.pathname;
	const method = request.method;
	const db = env.DB;
  const shortcut = shortcutTransport(request);

	try {
		const rateLimited = coordinatorState ? null : await limitNotificationRequest(request, admissionDb, env.NOTIFICATION_REQUEST_LIMITER);
		if (rateLimited) return withRequestId(rateLimited, requestId, started);
    const compatibility = shortcut && shortcutCompatibility(shortcut);
    if (compatibility) return withRequestId(corsResponse({ error: compatibility.message, code: compatibility.code }, compatibility.status), requestId, started);
		if (isCrateMutation(path, method) && path !== '/notifications/share/reading' && !shortcut) {
			const protocol = Number(request.headers.get(CRATE_PROTOCOL_HEADER));
			if (!Number.isInteger(protocol) || protocol < CRATE_PLUGIN_PROTOCOL.oldestCompatible || protocol > CRATE_PLUGIN_PROTOCOL.current) {
				return withRequestId(corsResponse({ error: 'Update Crate and reload the web app before making changes.', code: 'protocol_incompatible', protocol: CRATE_PLUGIN_PROTOCOL }, 428), requestId, started);
			}
		}
		// One-use public Reading grants must be redeemed under the coordinator.
		// Their bounded pre-auth admission runs above; ordinary routes authenticate
		// and authorize before entering the coordinator below.
		const readingGrant = method === 'POST' && (['/reading/exchange', '/reading/handoff', '/reading/shortcut-exchange'].includes(path) || shortcut?.kind === 'exchange');
		if (readingGrant && !coordinatorState) {
 const forwarded = new Request(request); forwarded.headers.set('X-Crate-Internal-Mutation', '1');
 return withRequestId(await env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection')).fetch(forwarded), requestId, started);
 }
 if (coordinatorState && readingGrant) return withRequestId(await handleReadingRoute(request, env, undefined, coordinatorState), requestId, started);
		const publicResponse = await handlePublicRoute(request, env, path, method);
		if (publicResponse) {
			return withRequestId(publicResponse, requestId, started);
		}

		const authResult = await authenticateWorkerRequest(request, db);
		if (!coordinatorState) await rememberAuthenticatedRequest(request, admissionDb, !authResult.response);
		if (authResult.response) {
			return withRequestId(authResult.response, requestId, started);
		}
    if (shortcut?.kind === 'prepare' && !shortcutMayBypassWireProtocol(shortcut, authResult.principal.scope, request.headers.get(CRATE_PROTOCOL_HEADER))) {
      return withRequestId(corsResponse({ error: 'This endpoint requires shortcut capture access.', code: 'shortcut_access_required' }, shortcut.legacy ? 428 : 403), requestId, started);
    }

    if (!isAuthenticatedRouteAllowed(authResult.principal, path, method)) return withRequestId(corsResponse({ error: 'Token is not authorized for this operation' }, 403), requestId, started);
		const mutation = isCrateMutation(path, method);
    if (coordinatorState && (path.startsWith('/reading/') || path === '/features' && method === 'POST')) await armNotificationCoordinator(coordinatorState);
    const notificationMutation = await affectsNotifications(request);
		if ((notificationMutation || path.startsWith('/reading/') || path === '/features') && !coordinatorState) {
			const stub = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection'));
			const forwarded = new Request(request);
			forwarded.headers.set('X-Crate-Internal-Mutation', '1');
			const forwardedResponse = await stub.fetch(forwarded);
			return withRequestId(forwardedResponse, forwardedResponse.headers.get('X-Crate-Request-Id') ?? requestId, started);
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
    const routeEnv = coordinatorState ? env : { ...env, commitUpload: coordinatedUpload(env), commitNewFiles: coordinatedNewFiles(env) };
		const response = await handleAuthenticatedRoute(request, routeEnv, path, method, authResult.principal, requestId)
			?? corsResponse({ error: 'Not found' }, 404);
		if (mutation) await logMutation(request, response, requestId, authResult.principal);
		return withRequestId(response, requestId, started);
	} catch (error) {
		if (error instanceof MarkdownEncodingError) return withRequestId(corsResponse({ error: error.message, code: 'unsupported_markdown_encoding' }, 409), requestId, started);
		if (error instanceof ReminderInputError) return withRequestId(corsResponse({ error: error.message, field: error.field, code: 'invalid_reminder_input' }, 400), requestId, started);
		if (error instanceof ReminderMarkdownContextError) return withRequestId(corsResponse({ error: error.message, code: 'reminder_markdown_context' }, 409), requestId, started);
		if (error instanceof FileNamespaceConflictError) return withRequestId(error.toResponse(), requestId, started);
      if (error instanceof ReminderIdentityConflictError) return withRequestId(corsResponse({ error: error.message, code: 'duplicate_reminder_identity' }, 409), requestId, started);
      if (error instanceof ReminderFileSizeError) return withRequestId(corsResponse({ error: error.message }, 413), requestId, started);
		if (error instanceof FileVersionConflictError) {
			return withRequestId(corsResponse({
				error: 'The reminder file changed. Refresh and retry your edit.',
				path: error.path,
				currentHash: error.currentHash,
			}, 409), requestId, started);
		}
		console.error('Unhandled worker request error', {
			method,
			path,
			requestId,
			errorClass: error instanceof Error ? error.name : 'UnknownError',
		});
		return withRequestId(corsResponse({ error: 'Internal server error' }, 500), requestId, started);
	}
}
