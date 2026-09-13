import type { UsageSnapshot } from './usage-snapshot';
import type { SecretKey } from '../plugin/settings-types';
import type { HttpTransport } from './http';
import { CloudflareOAuthClient, CloudflareReauthorizationRequired, type CloudflareOAuthTokens } from './oauth-client';
import { CLOUDFLARE_OAUTH_AUTHORIZE_URL, CLOUDFLARE_OAUTH_REDIRECT_URL, CLOUDFLARE_ANALYTICS_SCOPE, CLOUDFLARE_OAUTH_SCOPES } from './oauth-config';
import { constantTimeEqual, createPkcePair, randomBase64Url } from './pkce';
import { fetchCloudflareUsage } from './usage-service';

const USAGE_SCOPE = CLOUDFLARE_ANALYTICS_SCOPE;
interface Credentials extends CloudflareOAuthTokens { expiresAt: number }
interface Secrets {
	get(key: SecretKey): string | null | undefined;
	set(key: SecretKey, value: string): void;
	delete(key: SecretKey): void;
}
interface Options {
	clientId: string;
	transport: HttpTransport;
	secrets: Secrets;
	accountId: () => string | null | undefined;
	openExternal: (url: string) => void;
	signal: AbortSignal;
	now?: () => number;
	cache?: { read(): UsageSnapshot | null; write(snapshot: UsageSnapshot): Promise<void> };
}

/** Retains the setup login for on-demand usage; also supports reconnecting older installations. */
export class CloudflareUsageConnection {
	private readonly oauth: CloudflareOAuthClient;
	private readonly now: () => number;
	private pending?: { state: string; verifier: string; accountId: string; createdAt: number; revision: number };
	private revision = 0;
	private busy = false;
	private authorizationRequired = false;
	get needsAuthorization(): boolean { return this.authorizationRequired; }

	constructor(private readonly options: Options) {
		this.oauth = new CloudflareOAuthClient(options.clientId, options.transport);
		this.now = options.now ?? Date.now;
	}

	get snapshot(): UsageSnapshot | null {
		const snapshot = this.options.cache?.read();
		return snapshot && snapshot.accountId === this.options.accountId() ? snapshot : null;
	}

	get connected(): boolean {
		const account = this.options.accountId();
		return Boolean(account && this.read(account));
	}

	acceptAuthorization(accountId: string, tokens: CloudflareOAuthTokens): void {
		this.check(accountId, this.revision);
		this.validateScope(tokens);
		this.save(accountId, tokens);
		this.authorizationRequired = false;
		++this.revision;
		this.pending = undefined;
	}

	async connect(): Promise<void> {
		this.options.signal.throwIfAborted();
		if (this.busy) throw new Error('Wait for the current usage request to finish.');
		const accountId = this.options.accountId();
		if (!accountId) throw new Error('Connect a Cloudflare server first.');
		const revision = ++this.revision;
		const { verifier, challenge } = await createPkcePair();
		this.check(accountId, revision);
		const state = `usage-${randomBase64Url(32)}`;
		this.pending = { state, verifier, accountId, createdAt: this.now(), revision };
		const url = new URL(CLOUDFLARE_OAUTH_AUTHORIZE_URL);
		url.search = new URLSearchParams({
			response_type: 'code', client_id: this.options.clientId,
			redirect_uri: CLOUDFLARE_OAUTH_REDIRECT_URL,
			scope: [...CLOUDFLARE_OAUTH_SCOPES, 'offline_access'].join(' '), state,
			code_challenge: challenge, code_challenge_method: 'S256',
		}).toString();
		this.options.openExternal(url.toString());
	}

	async handleCallback(params: Record<string, string>): Promise<void> {
		this.options.signal.throwIfAborted();
		if (this.busy) throw new Error('A usage request is already in progress.');
		const pending = this.pending;
		if (!pending || !params.state || !constantTimeEqual(params.state, pending.state)) {
			throw new Error('Usage authorization did not match. Connect again.');
		}
		this.pending = undefined;
		this.check(pending.accountId, pending.revision);
		if (this.now() - pending.createdAt > 600_000) throw new Error('Usage authorization expired. Connect again.');
		if (params.error || !params.code) throw new Error('Usage authorization was cancelled or denied.');
		this.busy = true;
		let tokens: CloudflareOAuthTokens | undefined;
		try {
			tokens = await this.oauth.exchangeTokens(params.code, pending.verifier);
			this.check(pending.accountId, pending.revision);
			this.validateScope(tokens);
			// Verify that consent covers this server's account, even when all datasets are empty.
			const response = await this.options.transport('https://api.cloudflare.com/client/v4/graphql', {
				method: 'POST', headers: { Authorization: `Bearer ${tokens.accessToken}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ query: `query { viewer { accounts(filter: { accountTag: ${JSON.stringify(pending.accountId)} }) { accountTag } } }` }),
			});
			this.check(pending.accountId, pending.revision);
			const data = JSON.parse(response.text) as { errors?: unknown[]; data?: { viewer?: { accounts?: { accountTag: string }[] } } };
			if (response.status !== 200 || data.errors?.length || !data.data?.viewer?.accounts?.some(a => a.accountTag === pending.accountId)) {
				throw new Error('Authorize analytics for the account that owns this Crate server.');
			}
			this.save(pending.accountId, tokens);
			this.authorizationRequired = false;
			tokens = undefined;
		} finally {
			if (tokens) await this.revoke(tokens);
			this.busy = false;
		}
	}

	async withAuthorization<T>(operation: (tokens: CloudflareOAuthTokens) => Promise<T>): Promise<T> {
		const accountId = this.options.accountId();
		if (!accountId) throw new Error('Connect a Cloudflare server first.');
		if (this.busy) throw new Error('A usage request is already in progress.');
		const revision = this.revision;
		this.check(accountId, revision);
		let credentials = this.read(accountId);
		if (!credentials) throw new CloudflareReauthorizationRequired();
		this.busy = true;
		try {
			if (credentials.expiresAt <= this.now() + 60_000) {
				if (!credentials.refreshToken) throw new CloudflareReauthorizationRequired();
				const refreshed = await this.oauth.refreshTokens(credentials.refreshToken);
				try {
					this.check(accountId, revision);
					this.validateScope(refreshed);
					credentials = this.save(accountId, { ...refreshed, refreshToken: refreshed.refreshToken ?? credentials.refreshToken, scope: refreshed.scope ?? credentials.scope });
				} catch (error) {
					await this.revoke(refreshed);
					throw error;
				}
			}
			this.check(accountId, revision);
			const result = await operation(credentials);
			this.check(accountId, revision);
			return result;
		} catch (error) {
			if (error instanceof CloudflareReauthorizationRequired) this.authorizationRequired = true;
			throw error;
		} finally { this.busy = false; }
	}

	async fetchUsage() {
		const accountId = this.options.accountId();
		if (!accountId) throw new Error('Connect a Cloudflare server first.');
		const revision = this.revision;
		return this.withAuthorization(async credentials => {
			const updatedAt = this.now();
			const groups = await fetchCloudflareUsage(async (url, request) => {
				this.check(accountId, revision);
				const response = await this.options.transport(url, request);
				if (response.status === 401 || response.status === 403) this.authorizationRequired = true;
				this.check(accountId, revision);
				return response;
			}, credentials.accessToken, accountId, new Date(updatedAt));
			this.check(accountId, revision);
			if (groups.some(group => group.error) && this.snapshot) {
				throw new Error('Some usage could not be refreshed. Showing the last saved data. Try again later.');
			}
			if (!groups.some(group => group.metrics.length)) throw new Error('Usage is unavailable. Try again later.');
			await this.options.cache?.write({ accountId, updatedAt, groups });
			this.check(accountId, revision);
			return groups;
		});
	}

	async disconnect(): Promise<void> {
		++this.revision;
		this.pending = undefined;
		const accountId = this.options.accountId();
		if (!accountId) return;
		const credentials = this.read(accountId);
		this.options.secrets.delete(this.key(accountId));
		this.options.secrets.delete(`crate-analytics-${accountId}`);
		if (credentials && !await this.revoke(credentials)) {
			throw new Error('Removed from this device. Cloudflare could not confirm revocation; revoke Crate access in Cloudflare.');
		}
	}

	private key(account: string): SecretKey { return `crate-usage-oauth-${account}`; }
	private read(account: string): Credentials | undefined {
		try {
			const value = JSON.parse(this.options.secrets.get(this.key(account)) ?? 'null') as Credentials | null;
			if (value && typeof value.accessToken === 'string' && typeof value.expiresAt === 'number'
				&& (value.refreshToken === undefined || typeof value.refreshToken === 'string')) return value;
		} catch { /* Invalid local credentials require a new connection. */ }
		return undefined;
	}
	private save(account: string, tokens: CloudflareOAuthTokens): Credentials {
		const credentials = { ...tokens, expiresAt: this.now() + (tokens.expiresIn ?? 0) * 1000 };
		this.options.secrets.set(this.key(account), JSON.stringify(credentials));
		return credentials;
	}
	private validateScope(tokens: CloudflareOAuthTokens): void {
		if (tokens.scope !== undefined) {
			const scopes = tokens.scope.split(/\s+/);
			if (!scopes.includes(USAGE_SCOPE) || scopes.some(s => ![...CLOUDFLARE_OAUTH_SCOPES, 'offline_access'].includes(s))) {
				throw new Error('Cloudflare returned unexpected permissions. Authorize Crate’s configured permissions and try again.');
			}
		}
	}
	private check(accountId: string, revision: number): void {
		this.options.signal.throwIfAborted();
		if (revision !== this.revision || accountId !== this.options.accountId()) throw new Error('Cloudflare connection changed. Try again.');
	}
	private async revoke(tokens: CloudflareOAuthTokens): Promise<boolean> {
		const results = await Promise.allSettled([
			this.oauth.revokeAccessToken(tokens.accessToken),
			...(tokens.refreshToken ? [this.oauth.revokeAccessToken(tokens.refreshToken)] : []),
		]);
		return results.every(result => result.status === 'fulfilled');
	}
}
