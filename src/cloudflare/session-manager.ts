import { SECRET_KEYS, type CrateSettings } from '../plugin/types';
import type { SecretStorageService } from '../plugin/secret-storage';

export interface CloudflareCredentials {
	accountId: string;
	apiToken: string;
}

export class CloudflareSessionManager {
	constructor(
		private settings: CrateSettings,
		private secretStorage: SecretStorageService,
		private persistSettings: () => Promise<void>
	) {}

	hasCredentials(): boolean {
		return this.settings.cloudflareAccountId.length > 0
			&& this.secretStorage.has(SECRET_KEYS.CLOUDFLARE_API_TOKEN);
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
		return this.getCredentials();
	}

	async saveCredentials(accountId: string, apiToken: string): Promise<void> {
		const normalizedAccountId = accountId.trim();
		if (!normalizedAccountId) {
			throw new Error('Cloudflare account ID is required');
		}

		const normalizedApiToken = apiToken.trim();
		if (!normalizedApiToken) {
			throw new Error('Cloudflare API token is required');
		}

		this.settings.cloudflareAccountId = normalizedAccountId;
		this.secretStorage.set(SECRET_KEYS.CLOUDFLARE_API_TOKEN, normalizedApiToken);
		await this.persistSettings();
	}

	async clearCredentials(): Promise<void> {
		this.settings.cloudflareAccountId = '';
		this.secretStorage.delete(SECRET_KEYS.CLOUDFLARE_API_TOKEN);
		await this.persistSettings();
	}
}
