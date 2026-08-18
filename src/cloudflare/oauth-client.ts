import type { HttpTransport } from './http';
import {
	CLOUDFLARE_OAUTH_REDIRECT_URL,
	CLOUDFLARE_OAUTH_REVOKE_URL,
	CLOUDFLARE_OAUTH_TOKEN_URL,
} from './oauth-config';

export class CloudflareOAuthClient {
	constructor(
		private readonly clientId: string,
		private readonly transport: HttpTransport,
	) {}

	async exchangeAuthorizationCode(code: string, verifier: string): Promise<string> {
		const response = await this.transport(CLOUDFLARE_OAUTH_TOKEN_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				client_id: this.clientId,
				code,
				redirect_uri: CLOUDFLARE_OAUTH_REDIRECT_URL,
				code_verifier: verifier,
			}).toString(),
		});
		if (response.status < 200 || response.status >= 300) {
			throw new Error('Cloudflare rejected the OAuth authorization code');
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
		return accessToken;
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
