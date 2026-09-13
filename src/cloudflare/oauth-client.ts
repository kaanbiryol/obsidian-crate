import type { HttpTransport } from './http';
import {
	CLOUDFLARE_OAUTH_REDIRECT_URL,
	CLOUDFLARE_OAUTH_REVOKE_URL,
	CLOUDFLARE_OAUTH_TOKEN_URL,
} from './oauth-config';

export class CloudflareReauthorizationRequired extends Error {
	constructor() { super('Reconnect Cloudflare to authorize the update.'); }
}

export interface CloudflareOAuthTokens {
	accessToken: string;
	refreshToken?: string;
	expiresIn?: number;
	scope?: string;
}

export class CloudflareOAuthClient {
	constructor(
		private readonly clientId: string,
		private readonly transport: HttpTransport,
	) {}

	async exchangeTokens(code: string, verifier: string): Promise<CloudflareOAuthTokens> {
		return this.requestTokens({
			grant_type: 'authorization_code',
			code,
			redirect_uri: CLOUDFLARE_OAUTH_REDIRECT_URL,
			code_verifier: verifier,
		});
	}

	async refreshTokens(refreshToken: string): Promise<CloudflareOAuthTokens> {
		return this.requestTokens({ grant_type: 'refresh_token', refresh_token: refreshToken });
	}

	private async requestTokens(parameters: Record<string, string>): Promise<CloudflareOAuthTokens> {
		const response = await this.transport(CLOUDFLARE_OAUTH_TOKEN_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: this.clientId,
				...parameters,
			}).toString(),
		});
		if (response.status < 200 || response.status >= 300) {
			let errorCode: unknown;
			try { errorCode = (JSON.parse(response.text) as { error?: unknown }).error; } catch { /* Ignore non-JSON provider errors. */ }
			if (response.status === 401 || response.status === 403 || errorCode === 'invalid_grant' || errorCode === 'invalid_scope') {
				throw new CloudflareReauthorizationRequired();
			}
			throw new Error('Cloudflare authorization is unavailable. Try again later.');
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(response.text);
		} catch {
			throw new Error('Cloudflare returned an invalid OAuth response');
		}
		const accessToken = typeof parsed === 'object' && parsed !== null && 'access_token' in parsed
			? (parsed as { access_token?: unknown }).access_token
			: null;
		if (typeof accessToken !== 'string' || !accessToken) {
			throw new Error('Cloudflare did not return an OAuth access token');
		}
		const fields = parsed as Record<string, unknown>;
		return {
			accessToken,
			refreshToken: typeof fields.refresh_token === 'string' && fields.refresh_token ? fields.refresh_token : undefined,
			expiresIn: typeof fields.expires_in === 'number' && Number.isFinite(fields.expires_in) && fields.expires_in > 0 ? fields.expires_in : undefined,
			scope: typeof fields.scope === 'string' ? fields.scope : undefined,
		};
	}

	async revokeAccessToken(accessToken: string): Promise<void> {
		const response = await this.transport(CLOUDFLARE_OAUTH_REVOKE_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				client_id: this.clientId,
				token: accessToken,
			}).toString(),
		});
		if (response.status < 200 || response.status >= 300) {
			throw new Error('Cloudflare did not confirm OAuth token revocation');
		}
	}
}
