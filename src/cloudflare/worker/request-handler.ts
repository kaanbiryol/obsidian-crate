import { handleReadingRoute } from './reading/routes';
import { shortcutLaunchResponse, shortcutTransport } from './reading/shortcut-transport';
import { captureSealedReading } from './reading/sealed-capture';
import { ReadingError, readingResponse } from './reading/common';
import { isD1DailyLimitError, withD1Usage } from './d1-usage';
import { coordinatedNewFiles } from './sync/staging/bulk-upload-dispatch';
import { MarkdownEncodingError } from '@/reminders/core/markdownEncoding';
import { ReminderInputError } from '@/reminders/core/reminderMutationInput';
import { ReminderFileSizeError } from './reminders/limits';
import { ReminderIdentityConflictError } from './reminders/source-identity';
import { logMutation } from './request-diagnostics';
import { limitNotificationRequest } from './rate-limit';
import { rememberAuthenticatedRequest } from './auth/admission-state';
import { coordinatedUpload } from './sync/staging/staged-upload-dispatch';
import { apiRoutePolicy } from './routes/policy';
import { armNotificationCoordinator } from './notifications/lifecycle';
import { isCrateMutation } from '../../protocol/server-info';
import { corsHeaders, corsResponse } from './cors';
import { authenticateWorkerRequest } from './auth/index';
import { handleAuthenticatedRoute, handlePublicRoute, isAuthenticatedRouteAllowed } from './router';
import type { Env } from './types';
import { FileVersionConflictError } from './storage';
import { FileNamespaceConflictError } from './sync/file-namespace';
import { ReminderMarkdownContextError } from '@/reminders/core/markdownTaskContext';
import { EncryptionStateError } from './encryption/state';
import { ENCRYPTION_STATE_HEADER } from '../../encryption/server-state';
import { assertRequestEncryption, checkRequestProtocol } from './request-guards';
import { forwardTransferRequest } from './sync/transfer-dispatch';
import { scheduleMaintenance } from './maintenance/schedule';
import { commitStagedFile } from './sync/mutations';
import { commitNewFiles } from './sync/staging/bulk-new-file-commit';
import type { UploadCommitters } from './sync/staging/upload-committers';
import { ensureProjection, forwardToCoordinator } from '@/cloudflare/worker/coordinator/coordinator';
import { REQUEST_ID_HEADER } from '../../protocol/http-headers';

function withRequestId(response: Response, requestId: string, started: number, encryptionState?: 'on' | 'off'): Response {
	const headers = new Headers(response.headers);
	headers.set(REQUEST_ID_HEADER, requestId);
	if (encryptionState) headers.set(ENCRYPTION_STATE_HEADER, encryptionState);
	headers.set('Server-Timing', `crate;dur=${Math.max(0, performance.now() - started).toFixed(2)}`);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/** The coordinator stores its parser version once and only a deploy (fresh
 * isolates) can change it, so each isolate confirms the setup a single time. */
const ensuredProjections = new WeakSet<Env['REMINDER_ALARMS']>();

type WorkerExecution =
	| { kind: 'public' }
	| { kind: 'coordinator'; state: DurableObjectState }
	| { kind: 'transfer' };

/** Response headers settled while routing; `handleWorkerRequest` applies them once. */
interface ResponseContext {
	requestId: string;
	/** Set once the request is authenticated; unauthenticated responses omit it. */
	encryptionState?: 'on' | 'off';
}

export async function fetchWorkerRequest(request: Request, env: Env, execution: WorkerExecution = { kind: 'public' }): Promise<Response> {
	// Usage metering wraps the namespace per request; remember setup on the binding.
	const response = await withD1Usage(env, measured => handleWorkerRequest(request, measured, env.DB, execution, env.REMINDER_ALARMS));
	return shortcutLaunchResponse(request, response, env.CRATE_DEPLOYMENT_FINGERPRINT);
}

async function handleWorkerRequest(request: Request, env: Env, admissionDb: D1Database, execution: WorkerExecution,
	projectionBinding: Env['REMINDER_ALARMS']): Promise<Response> {
	const context: ResponseContext = { requestId: crypto.randomUUID() };
	const started = performance.now();
	let response: Response;
	try {
		response = await routeWorkerRequest(request, env, admissionDb, execution, projectionBinding, context);
	} catch (error) {
		response = errorResponse(error, request, context.requestId);
	}
	return withRequestId(response, context.requestId, started, context.encryptionState);
}

/** The coordinator or transfer object assigned its own request ID, which its logs use. */
function forwardedResponse(response: Response, context: ResponseContext): Response {
	context.requestId = response.headers.get(REQUEST_ID_HEADER) ?? context.requestId;
	return response;
}

async function routeWorkerRequest(request: Request, env: Env, admissionDb: D1Database, execution: WorkerExecution,
	projectionBinding: Env['REMINDER_ALARMS'], context: ResponseContext): Promise<Response> {
	if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

	const url = new URL(request.url);
	const path = url.pathname;
	const method = request.method;
	const db = env.DB;
	const shortcut = shortcutTransport(request);

	// Coordinator execution receives only requests this pipeline already admitted.
	// Transfer execution re-enters it after queuing, so edge admission and the
	// remembered credential below run a second time for transfer requests.
	const rateLimited = execution.kind === 'coordinator' ? null : await limitNotificationRequest(request, admissionDb, env.NOTIFICATION_REQUEST_LIMITER);
	if (rateLimited) return rateLimited;
	const protocolError = checkRequestProtocol(request, shortcut);
	if (protocolError) return protocolError;
	// One-use public Reading grants must be redeemed under the coordinator.
	// Their bounded pre-auth admission runs above; ordinary routes authenticate
	// and authorize before entering the coordinator below.
	const routePolicy = apiRoutePolicy(path, method);
	const routeExecution = routePolicy?.execution;
	const readingGrant = routeExecution?.kind === 'reading-grant';
	if (readingGrant && execution.kind !== 'coordinator') return forwardedResponse(await forwardToCoordinator(env, request), context);
	if (execution.kind === 'coordinator' && readingGrant) return handleReadingRoute(request, env, undefined, execution.state);
	const publicResponse = await handlePublicRoute(request, env, path, method);
	if (publicResponse) return publicResponse;
	// Coordinator routes authenticate once, under the coordinator lock that every
	// revocation also takes. The encrypted shortcut capture downloads its page here
	// before entering the coordinator, so it still authenticates at the edge.
	if (routeExecution?.kind === 'coordinator' && execution.kind !== 'coordinator' && shortcut?.kind !== 'prepare') {
		const response = await forwardToCoordinator(env, request);
		// Only an authenticated coordinator response carries the encryption state.
		if (response.headers.has(ENCRYPTION_STATE_HEADER)) await rememberAuthenticatedRequest(request, admissionDb, true);
		else if (response.status === 401) await rememberAuthenticatedRequest(request, admissionDb, false);
		return forwardedResponse(response, context);
	}

	const authResult = await authenticateWorkerRequest(request, db);
	if (execution.kind !== 'coordinator') await rememberAuthenticatedRequest(request, admissionDb, !authResult.response);
	if (authResult.response) return authResult.response;
	if (shortcut?.kind === 'prepare' && authResult.principal.scope !== 'reading_capture') {
		return corsResponse({ error: 'This endpoint requires shortcut capture access.', code: 'shortcut_access_required' }, 403);
	}

	if (!isAuthenticatedRouteAllowed(authResult.principal, path, method)) return corsResponse({ error: 'Token is not authorized for this operation' }, 403);
	const encryption = authResult.encryption ?? null;
	context.encryptionState = encryption ? 'on' : 'off';
	assertRequestEncryption(request, encryption);
	if (execution.kind === 'public' && routeExecution?.kind === 'transfer') {
		// Stream without decoding or hashing on the public Worker's CPU budget.
		// The transfer object reauthenticates after queuing, before reading bytes.
		return forwardedResponse(await forwardTransferRequest(request, env, routeExecution.path), context);
	}
	const mutation = isCrateMutation(path, method);
	// Download outside the coordinator; only the sealed commit takes its lock.
	if (shortcut?.kind === 'prepare' && encryption && execution.kind !== 'coordinator') {
		try { return await captureSealedReading(request, env, authResult.principal, encryption); }
		catch (error) { if (error instanceof ReadingError) return readingResponse({ error: error.message, code: error.code }, error.status); throw error; }
	}
	if (routeExecution?.kind === 'coordinator' && execution.kind !== 'coordinator') return forwardedResponse(await forwardToCoordinator(env, request), context);
	if (!mutation && execution.kind !== 'coordinator' && routePolicy?.initializeProjection && !ensuredProjections.has(projectionBinding)) {
		if (!await ensureProjection(env)) throw new Error('Unable to initialize notification processing');
		ensuredProjections.add(projectionBinding);
	}
	if (routeExecution?.kind === 'coordinator' && routeExecution.wake && execution.kind === 'coordinator') await armNotificationCoordinator(execution.state);
	if (mutation && execution.kind !== 'coordinator') {
		await scheduleMaintenance(env, projectionBinding);
	}
	const uploadCommitters: UploadCommitters = execution.kind === 'coordinator'
		? { commitUpload: commitStagedFile, commitNewFiles }
		: { commitUpload: coordinatedUpload(env), commitNewFiles: coordinatedNewFiles(env) };
	const response = await handleAuthenticatedRoute(request, env, {
		uploadCommitters, path, method, principal: authResult.principal, resetGeneration: authResult.resetGeneration,
		requestId: context.requestId, encryption, featurePolicyValue: authResult.featurePolicyValue,
	}) ?? corsResponse({ error: 'Not found' }, 404);
	if (mutation) await logMutation(request, response, context.requestId, authResult.principal);
	return response;
}

/** Domain errors keep their status and code; anything else is logged and hidden. */
function errorResponse(error: unknown, request: Request, requestId: string): Response {
	if (error instanceof EncryptionStateError) return corsResponse({ error: error.message, code: 'encryption_required' }, error.status);
	if (error instanceof MarkdownEncodingError) return corsResponse({ error: error.message, code: 'unsupported_markdown_encoding' }, 409);
	if (error instanceof ReminderInputError) return corsResponse({ error: error.message, field: error.field, code: 'invalid_reminder_input' }, 400);
	if (error instanceof ReminderMarkdownContextError) return corsResponse({ error: error.message, code: 'reminder_markdown_context' }, 409);
	if (error instanceof FileNamespaceConflictError) return error.toResponse();
	if (error instanceof ReminderIdentityConflictError) return corsResponse({ error: error.message, code: 'duplicate_reminder_identity' }, 409);
	if (error instanceof ReminderFileSizeError) return corsResponse({ error: error.message }, 413);
	if (error instanceof FileVersionConflictError) {
		return corsResponse({
			error: 'The reminder file changed. Refresh and retry your edit.',
			path: error.path,
			currentHash: error.currentHash,
		}, 409);
	}
	// No Retry-After: clients would wait out their capped delays for a limit that resets at 00:00 UTC.
	if (isD1DailyLimitError(error)) {
		return corsResponse({ error: 'Cloudflare’s free daily database limit was reached. Sync can continue after 00:00 UTC.', code: 'd1_daily_limit' }, 429);
	}
	console.error('Unhandled worker request error', {
		method: request.method,
		path: new URL(request.url).pathname,
		requestId,
		errorClass: error instanceof Error ? error.name : 'UnknownError',
	});
	return corsResponse({ error: 'Internal server error' }, 500);
}
