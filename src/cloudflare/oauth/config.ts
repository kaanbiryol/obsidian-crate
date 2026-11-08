declare const __CRATE_CLOUDFLARE_OAUTH_CLIENT_ID__: string;

export const CLOUDFLARE_OAUTH_CLIENT_ID = typeof __CRATE_CLOUDFLARE_OAUTH_CLIENT_ID__ === 'undefined'
	? 'not-configured'
	: __CRATE_CLOUDFLARE_OAUTH_CLIENT_ID__;
export const CLOUDFLARE_OAUTH_AUTHORIZE_URL = 'https://dash.cloudflare.com/oauth2/auth';
export const CLOUDFLARE_OAUTH_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
export const CLOUDFLARE_OAUTH_REVOKE_URL = 'https://dash.cloudflare.com/oauth2/revoke';
export const CLOUDFLARE_OAUTH_REDIRECT_URL = 'https://crate.kaanbiryol.com/oauth/callback/';

export const CLOUDFLARE_ANALYTICS_SCOPE = 'account-analytics.read';

/** Scope IDs returned by Cloudflare's authenticated GET /oauth/scopes endpoint. */
export const CLOUDFLARE_OAUTH_SCOPES = [
	'workers-scripts.write',
	'd1.write',
	'workers-r2.write',
	'memberships.read',
	CLOUDFLARE_ANALYTICS_SCOPE,
] as const;

/** Whether a token's space-separated `granted` scopes include each `required` one. */
export function hasOAuthScopes(granted: string, required: readonly string[] = CLOUDFLARE_OAUTH_SCOPES): boolean {
	const scopes = granted.split(/\s+/);
	return required.every(scope => scopes.includes(scope));
}

/** Whether a token's space-separated `granted` scopes are all ones Crate requests. */
export function hasOnlyRequestedOAuthScopes(granted: string): boolean {
	const requested: readonly string[] = [...CLOUDFLARE_OAUTH_SCOPES, 'offline_access'];
	return granted.split(/\s+/).every(scope => requested.includes(scope));
}

export function isCloudflareOAuthConfigured(): boolean {
	return CLOUDFLARE_OAUTH_CLIENT_ID !== 'not-configured'
		&& /^[a-f0-9]{32}$/i.test(CLOUDFLARE_OAUTH_CLIENT_ID);
}
