declare const __CRATE_CLOUDFLARE_OAUTH_CLIENT_ID__: string;

export const CLOUDFLARE_OAUTH_CLIENT_ID = typeof __CRATE_CLOUDFLARE_OAUTH_CLIENT_ID__ === 'undefined'
	? 'not-configured'
	: __CRATE_CLOUDFLARE_OAUTH_CLIENT_ID__;
export const CLOUDFLARE_OAUTH_AUTHORIZE_URL = 'https://dash.cloudflare.com/oauth2/auth';
export const CLOUDFLARE_OAUTH_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
export const CLOUDFLARE_OAUTH_REVOKE_URL = 'https://dash.cloudflare.com/oauth2/revoke';
export const CLOUDFLARE_OAUTH_REDIRECT_URL = 'https://crate.kaanbiryol.com/oauth/callback/';

/** Scope IDs returned by Cloudflare's authenticated GET /oauth/scopes endpoint. */
export const CLOUDFLARE_OAUTH_SCOPES = [
	'workers-scripts.write',
	'd1.write',
	'workers-r2.write',
	'memberships.read',
] as const;

export function isCloudflareOAuthConfigured(): boolean {
	return CLOUDFLARE_OAUTH_CLIENT_ID !== 'not-configured'
		&& /^[a-f0-9]{32}$/i.test(CLOUDFLARE_OAUTH_CLIENT_ID);
}
