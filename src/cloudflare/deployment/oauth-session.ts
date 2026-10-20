import {
	CLOUDFLARE_OAUTH_AUTHORIZE_URL,
	CLOUDFLARE_OAUTH_REDIRECT_URL,
	CLOUDFLARE_OAUTH_SCOPES,
} from '../oauth/config';
import { constantTimeEqual, createPkcePair, randomBase64Url } from '../oauth/pkce';
import type { DeploymentIntent, DeploymentRequest } from './types';

const OAUTH_SESSION_MAX_AGE_MS = 10 * 60 * 1000;

interface PendingOAuthSession {
	state: string;
	verifier: string;
	createdAt: number;
	request: DeploymentRequest;
}

/** The browser hand-off for one deployment request: PKCE, state matching and expiry. */
export class CloudflareOAuthSession {
	private pending: PendingOAuthSession | null = null;
	private generation = 0;

	constructor(
		private readonly clientId: string,
		private readonly now: () => number,
		private readonly openExternal: (url: string) => void,
	) {}

	get intent(): DeploymentIntent | null {
		return this.pending?.request.intent ?? null;
	}

	/** Open Cloudflare's consent page, unless a cancel arrives while PKCE is prepared. */
	async start(request: DeploymentRequest, signal: AbortSignal): Promise<void> {
		const generation = this.generation;
		const { verifier, challenge } = await createPkcePair();
		signal.throwIfAborted();
		if (generation !== this.generation) return;
		const state = randomBase64Url(32);
		this.pending = { verifier, state, createdAt: this.now(), request };

		const authorizationUrl = new URL(CLOUDFLARE_OAUTH_AUTHORIZE_URL);
		authorizationUrl.search = new URLSearchParams({
			response_type: 'code',
			client_id: this.clientId,
			redirect_uri: CLOUDFLARE_OAUTH_REDIRECT_URL,
			scope: [...CLOUDFLARE_OAUTH_SCOPES, 'offline_access'].join(' '),
			state,
			code_challenge: challenge,
			code_challenge_method: 'S256',
		}).toString();
		this.openExternal(authorizationUrl.toString());
	}

	/** Consume the pending session for a callback, or explain why it cannot be used. */
	take(params: Record<string, string>): { code: string; verifier: string; request: DeploymentRequest } {
		const pending = this.pending;
		if (!pending) {
			throw new Error('No Cloudflare deployment is waiting for authorization. Start again from Crate settings');
		}
		if (!params.state || !constantTimeEqual(params.state, pending.state)) {
			throw new Error('Cloudflare authorization state did not match. Start the deployment again');
		}
		this.pending = null;
		if (this.now() - pending.createdAt > OAUTH_SESSION_MAX_AGE_MS) {
			throw new Error('Cloudflare authorization expired. Start the deployment again');
		}
		if (params.error) {
			throw new Error('Cloudflare authorization was cancelled or denied');
		}
		if (!params.code) {
			throw new Error('Cloudflare did not return an authorization code');
		}
		return { code: params.code, verifier: pending.verifier, request: pending.request };
	}

	cancel(): void {
		this.generation++;
		this.pending = null;
	}
}
