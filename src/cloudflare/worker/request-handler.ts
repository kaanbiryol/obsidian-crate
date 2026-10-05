import { handleReadingRoute } from './reading/routes';
import { shortcutLaunchResponse, shortcutTransport } from './reading/shortcut-transport';
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
import { isCrateMutation } from '../../protocol';
import { corsHeaders, corsResponse } from './cors';
import { authenticateWorkerRequest } from './auth/index';
import { handleAuthenticatedRoute, handlePublicRoute, isAuthenticatedRouteAllowed } from './router';
import type { Env } from './types';
import { FileVersionConflictError } from './storage/index';
import { FileNamespaceConflictError } from './file-namespace';
import { ReminderMarkdownContextError } from '@/reminders/core/markdownTaskContext';
import { EncryptionStateError } from './encryption-state';
import { assertRequestEncryption, checkRequestProtocol } from './request-guards';
import { forwardTransferRequest } from './transfer-dispatch';

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

type WorkerExecution =
	| { kind: 'public' }
	| { kind: 'coordinator'; state: DurableObjectState }
	| { kind: 'transfer' };

export async function fetchWorkerRequest(request: Request, env: Env, execution: WorkerExecution = { kind: 'public' }): Promise<Response> {
	const response = await withD1Usage(env, measured => handleWorkerRequest(request, measured, env.DB, execution));
	return shortcutLaunchResponse(request, response, env.CRATE_DEPLOYMENT_FINGERPRINT);
}

async function handleWorkerRequest(request: Request, env: Env, admissionDb: D1Database, execution: WorkerExecution): Promise<Response> {
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
		const rateLimited = execution.kind === 'coordinator' ? null : await limitNotificationRequest(request, admissionDb, env.NOTIFICATION_REQUEST_LIMITER);
		if (rateLimited) return withRequestId(rateLimited, requestId, started);
		const protocolError = checkRequestProtocol(request, shortcut);
		if (protocolError) return withRequestId(protocolError, requestId, started);
		// One-use public Reading grants must be redeemed under the coordinator.
		// Their bounded pre-auth admission runs above; ordinary routes authenticate
		// and authorize before entering the coordinator below.
		const readingGrant = method === 'POST' && (['/reading/exchange', '/reading/handoff'].includes(path) || shortcut?.kind === 'exchange');
		if (readingGrant && execution.kind !== 'coordinator') {
			const forwarded = new Request(request);
			forwarded.headers.set('X-Crate-Internal-Mutation', '1');
			return withRequestId(await env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection')).fetch(forwarded), requestId, started);
		}
		if (execution.kind === 'coordinator' && readingGrant) return withRequestId(await handleReadingRoute(request, env, undefined, execution.state), requestId, started);
		const publicResponse = await handlePublicRoute(request, env, path, method);
		if (publicResponse) {
			return withRequestId(publicResponse, requestId, started);
		}

		const authResult = await authenticateWorkerRequest(request, db);
		if (execution.kind !== 'coordinator') await rememberAuthenticatedRequest(request, admissionDb, !authResult.response);
		if (authResult.response) {
			return withRequestId(authResult.response, requestId, started);
		}
		if (shortcut?.kind === 'prepare' && authResult.principal.scope !== 'reading_capture') {
			return withRequestId(corsResponse({ error: 'This endpoint requires shortcut capture access.', code: 'shortcut_access_required' }, 403), requestId, started);
		}

		if (!isAuthenticatedRouteAllowed(authResult.principal, path, method)) return withRequestId(corsResponse({ error: 'Token is not authorized for this operation' }, 403), requestId, started);
		const encryption = authResult.encryption ?? null;
		assertRequestEncryption(request, encryption);
		if (execution.kind === 'public' && ((path === '/sync/upload' && method === 'PUT') || (path === '/sync/batch-upload' && method === 'POST'))) {
			// Stream without decoding or hashing on the public Worker's CPU budget.
			// The transfer object reauthenticates after queuing, before reading bytes.
			const response = await forwardTransferRequest(request, env, path === '/sync/upload' ? '/sync-upload' : '/sync-batch-upload');
			return withRequestId(response, response.headers.get('X-Crate-Request-Id') ?? requestId, started);
		}
		const mutation = isCrateMutation(path, method);
		if (execution.kind === 'coordinator' && (path.startsWith('/reading/') || path === '/features' && method === 'POST')) await armNotificationCoordinator(execution.state);
		const notificationMutation = await affectsNotifications(request);
		if ((notificationMutation || path.startsWith('/reading/') || path === '/features') && execution.kind !== 'coordinator') {
			const stub = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection'));
			const forwarded = new Request(request);
			forwarded.headers.set('X-Crate-Internal-Mutation', '1');
			const forwardedResponse = await stub.fetch(forwarded);
			return withRequestId(forwardedResponse, forwardedResponse.headers.get('X-Crate-Request-Id') ?? requestId, started);
		}
		if (!mutation && execution.kind !== 'coordinator' && ['/sync/check', '/sync/manifest', '/reminders/list'].includes(path)) {
			const stub = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/projection'));
			const ensured = await stub.fetch('https://do/ensure', { method: 'POST' });
			if (!ensured.ok) throw new Error('Unable to initialize notification processing');
		}
		if (notificationMutation && execution.kind === 'coordinator') await armNotificationCoordinator(execution.state);
		if (mutation && execution.kind !== 'coordinator') {
			const maintenance = env.REMINDER_ALARMS.get(env.REMINDER_ALARMS.idFromName('__crate__/maintenance'));
			const scheduled = await maintenance.fetch('https://do/maintain', { method: 'POST' });
			if (!scheduled.ok) throw new Error('Unable to schedule cleanup');
		}
		const routeEnv = execution.kind === 'coordinator' ? env : { ...env, commitUpload: coordinatedUpload(env), commitNewFiles: coordinatedNewFiles(env) };
		const response = await handleAuthenticatedRoute(request, routeEnv, path, method, authResult.principal, authResult.resetGeneration, requestId, encryption)
			?? corsResponse({ error: 'Not found' }, 404);
		if (mutation) await logMutation(request, response, requestId, authResult.principal);
		return withRequestId(response, requestId, started);
	} catch (error) {
		if (error instanceof EncryptionStateError) return withRequestId(corsResponse({ error: error.message, code: 'encryption_required' }, error.status), requestId, started);
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
