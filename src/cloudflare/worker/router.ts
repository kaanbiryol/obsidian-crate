import { featureEnabled, handleFeaturePolicy, parseStoredFeaturePolicy } from './feature-policy';
import { handleReadingRoute } from './reading/routes';
import { MAX_ENCRYPTED_REMINDER_REQUEST_BYTES } from '../../encryption/receipt-format';
import { parseJsonObject } from './request-validation';
import { limitNotificationAction } from './rate-limit';
import { handleAuthRoute } from './routes/auth';
import { handleNotificationsRoute } from './routes/notifications';
import { handlePublicRoute } from './routes/public';
import { handleRemindersRoute } from './routes/reminders';
import { handleServerRoute } from './routes/server';
import { handleSyncRoute } from './routes/sync';
import type { Env } from './types';
import type { AuthPrincipal } from './auth/index';
import { corsResponse } from './cors';
import { mutationAuditContext } from './request-diagnostics';
import { handleLinkTitle } from './link-title';
import { apiRoutePolicy } from './routes/policy';
import { handleEncryptionRoute } from './routes/encryption';
import { handleEncryptedFolderFiles } from './encryption/encrypted-folder-files';
import { handleEncryptionReset } from './encryption/reset';
import { handleEncryptionConversion } from './encryption/conversion';
import type { EncryptionServerState } from '../../encryption/server-state';
import type { UploadCommitters } from './sync/upload-committers';


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

interface AuthenticatedRouteContext {
	uploadCommitters: UploadCommitters;
	path: string;
	method: Request['method'];
	principal: AuthPrincipal;
	resetGeneration: string | null;
	requestId?: string;
	encryption?: EncryptionServerState | null;
	featurePolicyValue?: string | null;
}

/** Dispatch a request whose principal the caller has already checked with isAuthenticatedRouteAllowed. */
export async function handleAuthenticatedRoute(
	request: Request,
	env: Env,
	{ uploadCommitters, path, method, principal, resetGeneration, requestId, encryption, featurePolicyValue }: AuthenticatedRouteContext,
): Promise<Response | null> {
	if (path === '/features' && ['GET', 'POST'].includes(method)) {
		const limited = await limitNotificationAction(request, env.DB, principal.tokenId);
		return limited ?? handleFeaturePolicy(request, env.DB);
	}
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
		if (!principal.folderPath || folder !== principal.folderPath) return corsResponse({ error: 'This session is limited to its enrolled reminders folder' }, 403);
	}
	if (path.startsWith('/reading/')) return handleReadingRoute(request, env, principal, undefined, encryption);
	const db = env.DB;
	const limited = await limitNotificationAction(request, db, principal.tokenId);
	if (limited) return limited;
	if (path === '/links/title' && method === 'POST') {
		if (env.NOTIFICATION_REQUEST_LIMITER && !(await env.NOTIFICATION_REQUEST_LIMITER.limit({ key: `link-titles:${principal.tokenId}` })).success) {
			return corsResponse({ title: null }, 429, { 'Retry-After': '60' });
		}
		return handleLinkTitle(request, env.READING_FETCH);
	}

	return await handleEncryptionReset(request, env, path, principal)
		?? (principal.scope === 'vault' ? await handleEncryptionConversion(request, env, path) : null)
		?? await handleEncryptionRoute(request, db, path, principal, encryption)
		?? await handleEncryptedFolderFiles(request, env, path, 'reminders', principal.scope === 'reminders' ? principal.folderPath : undefined)
		?? await handleSyncRoute(request, env, uploadCommitters, path, method, resetGeneration, mutationAuditContext(request, principal, requestId), encryption)
		?? await handleAuthRoute(request, env, path, method)
		?? await handleRemindersRoute(request, env, path, method)
		?? await handleNotificationsRoute(request, db, path, method, principal)
		?? await handleServerRoute(db, path, method);
}
