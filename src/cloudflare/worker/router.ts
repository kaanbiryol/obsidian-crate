import { featureEnabled, parseStoredFeaturePolicy } from './server/feature-policy';
import { handleReadingRoute } from './reading/routes';
import { forwardToCoordinator } from './coordinator/coordinator';
import { MAX_ENCRYPTED_REMINDER_REQUEST_BYTES } from '../../encryption/receipt-format';
import { parseJsonObject } from './http/request-validation';
import { chargeRouteAction } from './admission/rate-limit';
import { handleAuthRoute } from './routes/auth';
import { handleNotificationsRoute } from './routes/notifications';
import { handlePublicRoute } from './routes/public';
import { handleRemindersRoute } from './routes/reminders';
import { handleServerRoute } from './routes/server';
import { handleSyncRoute } from './routes/sync';
import type { Env } from './types';
import type { AuthPrincipal } from './auth/index';
import { corsResponse } from './http/cors';
import { apiRoutePolicy } from './routes/policy';
import { handleEncryptionRoute } from './routes/encryption';
import type { EncryptionServerState } from '../../encryption/server-state';
import { REMINDERS_FOLDER_CHANGED } from '../../protocol/web-session';
import type { UploadCommitters } from './sync/staging/upload-committers';


export { handlePublicRoute };

export function isAuthenticatedRouteAllowed(
	principal: AuthPrincipal,
	path: string,
	method: Request['method'],
): boolean {
	const policy = apiRoutePolicy(path, method);
	// Admission rejects unknown routes before authentication. Vault credentials
	// retain their broad authority; scoped sessions only use declared routes.
	return policy ? policy.scopes.includes(principal.scope) : principal.scope === 'vault';
}

export interface AuthenticatedRouteContext {
	uploadCommitters: UploadCommitters;
	path: string;
	method: Request['method'];
	principal: AuthPrincipal;
	resetGeneration: string | null;
	requestId?: string;
	encryption?: EncryptionServerState | null;
	featurePolicyValue?: string | null;
	coordinatorState?: DurableObjectState;
}

/** Dispatch a request whose principal the caller has already checked with isAuthenticatedRouteAllowed. */
export async function handleAuthenticatedRoute(
	request: Request,
	env: Env,
	context: AuthenticatedRouteContext,
): Promise<Response | null> {
	const { path, method, principal, encryption, featurePolicyValue, coordinatorState } = context;
	const remindersEnabled = async () => featurePolicyValue === undefined
		? await featureEnabled(env.DB, 'reminders')
		: parseStoredFeaturePolicy(featurePolicyValue).reminders;
	if (path.startsWith('/reminders/') && !await remindersEnabled()) return corsResponse({ error: 'Reminders are paused. Enable them in Crate settings.', code: 'feature_paused' }, 423);
	if (principal.scope === 'reminders' && path.startsWith('/reminders/')) {
		let folder: unknown = new URL(request.url).searchParams.get('folderPath');
		if (method !== 'GET') {
			const parsed = await parseJsonObject(request.clone(), path === '/reminders/encrypted-commit' ? MAX_ENCRYPTED_REMINDER_REQUEST_BYTES : undefined);
			if (!parsed.ok) return parsed.response;
			folder = parsed.value.folderPath;
		}
		if (!principal.folderPath) return corsResponse({ error: 'This session is limited to its enrolled reminders folder' }, 403);
		// Sessions follow reminders folder changes; the web app switches to the folder named here.
		if (folder !== principal.folderPath) return corsResponse({ error: 'The reminders folder changed', code: REMINDERS_FOLDER_CHANGED, folderPath: principal.folderPath }, 403);
	}
	if (path.startsWith('/reading/')) return handleReadingRoute(request, env, principal, coordinatorState, encryption, featurePolicyValue,
		coordinatorState ? undefined : () => forwardToCoordinator(env, request));
	// Charged once for every remaining route.
	const limited = await chargeRouteAction(request, env.DB, principal.tokenId);
	if (limited) return limited;

	return await handleEncryptionRoute(request, env, context)
		?? await handleSyncRoute(request, env, context)
		?? await handleAuthRoute(request, env, context)
		?? await handleRemindersRoute(request, env, context)
		?? await handleNotificationsRoute(request, env.DB, context)
		?? await handleServerRoute(request, env, context);
}
