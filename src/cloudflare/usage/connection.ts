import type { UsageSnapshot } from './snapshot';
import type { HttpTransport } from '../http';
import { CloudflareOAuthClient, CloudflareReauthorizationRequired, type CloudflareOAuthTokens } from '../oauth/client';
import { CLOUDFLARE_ANALYTICS_SCOPE, CLOUDFLARE_OAUTH_SCOPES } from '../oauth/config';
import { fetchCloudflareUsage } from './service';
import type { SecretKey } from '../../platform/secret-keys';

const USAGE_SCOPE = CLOUDFLARE_ANALYTICS_SCOPE;
// Renew early so a long deployment or reset does not outlive its access token.
const RENEWAL_MARGIN_MS = 600_000;
interface Credentials extends CloudflareOAuthTokens { expiresAt: number }
interface Secrets {
	get(key: SecretKey): string | null | undefined;
	set(key: SecretKey, value: string): void;
}
interface Options {
	clientId: string;
	transport: HttpTransport;
	secrets: Secrets;
	accountId: () => string | null | undefined;
	signal: AbortSignal;
	now?: () => number;
	cache?: { read(): UsageSnapshot | null; write(snapshot: UsageSnapshot): Promise<void> };
}

/** Retains the setup login for on-demand usage and saved-login server operations. */
export class CloudflareUsageConnection {
	private readonly oauth: CloudflareOAuthClient;
	private readonly now: () => number;
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
	}

	/** Revokes the saved login best effort and clears it, for example after its server is deleted. */
	async forget(accountId: string): Promise<void> {
		const credentials = this.read(accountId);
		this.options.secrets.set(this.key(accountId), '');
		++this.revision;
		if (credentials) await this.revoke(credentials);
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
			if (credentials.expiresAt <= this.now() + RENEWAL_MARGIN_MS) {
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
			const failures = groups.filter(group => group.error).map(group => `${group.label}: ${group.error}`).join(' ');
			if (failures && this.snapshot) {
				throw new Error(`Some usage could not be refreshed. Showing the last saved data. ${failures}`);
			}
			if (!groups.some(group => group.metrics.length)) throw new Error(`Usage is unavailable. ${failures}`);
			await this.options.cache?.write({ accountId, updatedAt, groups });
			this.check(accountId, revision);
			return groups;
		});
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
