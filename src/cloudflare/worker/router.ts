import { handleReadingRoute } from './routes/reading';
import { forwardToCoordinator } from './coordinator/coordinator';
import { chargeRouteAction } from './admission/rate-limit';
import { handleAuthRoute } from './routes/auth';
import { handleNotificationsRoute } from './routes/notifications';
import { handlePublicRoute } from './routes/public';
import { handleRemindersRoute } from './routes/reminders';
import { handleServerRoute } from './routes/server';
import { handleSyncRoute } from './routes/sync';
import type { Env } from './types';
import type { AuthPrincipal } from './auth/index';
import { apiRoutePolicy } from './routes/policy';
import { handleEncryptionRoute } from './routes/encryption';
import type { EncryptionServerState } from '../../encryption/server-state';
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
	const { path, principal, encryption, featurePolicyValue, coordinatorState } = context;
	if (path.startsWith('/reading/')) return handleReadingRoute(request, env, principal, { state: coordinatorState, encryption, featurePolicy: featurePolicyValue,
		forward: coordinatorState ? undefined : () => forwardToCoordinator(env, request) });
	// Charged once for every remaining route. No `/reminders/` route is rate limited, so
	// `handleRemindersRoute` still checks the feature and session folder before any charge.
	const limited = await chargeRouteAction(request, env.DB, principal.tokenId);
	if (limited) return limited;

	return await handleEncryptionRoute(request, env, context)
		?? await handleSyncRoute(request, env, context)
		?? await handleAuthRoute(request, env, context)
		?? await handleRemindersRoute(request, env, context)
		?? await handleNotificationsRoute(request, env, context)
		?? await handleServerRoute(request, env, context);
}
