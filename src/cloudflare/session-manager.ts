import { SECRET_KEYS, type CrateSettings } from '../types';
import type { SecretStorageService } from '../secret-storage';
import { performOAuthLogin, refreshAccessToken } from './oauth';

export interface CloudflareCredentials {
	accountId: string;
	apiToken: string;
}

interface SaveCloudflareCredentialOptions {
	refreshToken?: string;
	expiresAt?: number | null;
}

export class CloudflareSessionManager {
	constructor(
		private settings: CrateSettings,
		private secretStorage: SecretStorageService,
		private persistSettings: () => Promise<void>
	) {}

	hasCredentials(): boolean {
		return this.settings.cloudflareAccountId.length > 0 && (
			this.secretStorage.has(SECRET_KEYS.CLOUDFLARE_API_TOKEN) ||
			this.secretStorage.has(SECRET_KEYS.CLOUDFLARE_REFRESH_TOKEN)
		);
	}

	getCredentials(): CloudflareCredentials | null {
		const accountId = this.settings.cloudflareAccountId.trim();
		const apiToken = (this.secretStorage.get(SECRET_KEYS.CLOUDFLARE_API_TOKEN) || '').trim();
		if (!accountId || !apiToken) {
			return null;
		}
		return { accountId, apiToken };
	}

	async resolveCredentials(): Promise<CloudflareCredentials | null> {
		const accountId = this.settings.cloudflareAccountId.trim();
		let apiToken = (this.secretStorage.get(SECRET_KEYS.CLOUDFLARE_API_TOKEN) || '').trim();
		const refreshToken = (this.secretStorage.get(SECRET_KEYS.CLOUDFLARE_REFRESH_TOKEN) || '').trim();

		if (!accountId) {
			return null;
		}

		const expiresAt = this.settings.cloudflareTokenExpiresAt;
		const shouldRefresh = !!refreshToken && (!apiToken || (!!expiresAt && Date.now() > expiresAt - 60_000));
		if (shouldRefresh) {
			const refreshed = await refreshAccessToken(refreshToken);
			apiToken = refreshed.accessToken;
			await this.saveCredentials(accountId, apiToken, {
				refreshToken: refreshed.refreshToken || refreshToken,
				expiresAt: refreshed.expiresAt ?? null,
			});
		}

		if (!apiToken) {
			return null;
		}

		return { accountId, apiToken };
	}

	async loginWithCloudflare(): Promise<{ accountId: string }> {
		const result = await performOAuthLogin(async (url: string) => {
			window.open(url, '_blank', 'noopener,noreferrer');
		});

		await this.saveCredentials(result.accountId, result.tokens.accessToken, {
			refreshToken: result.tokens.refreshToken,
			expiresAt: result.tokens.expiresAt ?? null,
		});

		return { accountId: result.accountId };
	}

	async saveCredentials(
		accountId: string,
		apiToken: string,
		options?: SaveCloudflareCredentialOptions
	): Promise<void> {
		this.settings.cloudflareAccountId = accountId.trim();
		this.settings.cloudflareTokenExpiresAt = options?.expiresAt ?? null;
		this.secretStorage.set(SECRET_KEYS.CLOUDFLARE_API_TOKEN, apiToken.trim());
		if (options && Object.prototype.hasOwnProperty.call(options, 'refreshToken')) {
			const refreshToken = options.refreshToken?.trim() || '';
			if (refreshToken) {
				this.secretStorage.set(SECRET_KEYS.CLOUDFLARE_REFRESH_TOKEN, refreshToken);
			} else {
				this.secretStorage.delete(SECRET_KEYS.CLOUDFLARE_REFRESH_TOKEN);
			}
		} else if (!options) {
			this.secretStorage.delete(SECRET_KEYS.CLOUDFLARE_REFRESH_TOKEN);
		}
		await this.persistSettings();
	}

	async clearCredentials(): Promise<void> {
		this.settings.cloudflareAccountId = '';
		this.settings.cloudflareTokenExpiresAt = null;
		this.secretStorage.delete(SECRET_KEYS.CLOUDFLARE_API_TOKEN);
		this.secretStorage.delete(SECRET_KEYS.CLOUDFLARE_REFRESH_TOKEN);
		await this.persistSettings();
	}
}
