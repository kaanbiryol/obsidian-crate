import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretStorageService } from '../secret-storage';
import { DEFAULT_SETTINGS, SECRET_KEYS } from '../types';

const oauthMocks = vi.hoisted(() => ({
	performOAuthLogin: vi.fn(),
	refreshAccessToken: vi.fn(),
}));

vi.mock('./oauth', () => oauthMocks);

import { CloudflareSessionManager } from './session-manager';

describe('CloudflareSessionManager', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('treats a refresh-token-only session as recoverable credentials', () => {
		const storage = {
			has: vi.fn((key: string) => key === SECRET_KEYS.CLOUDFLARE_REFRESH_TOKEN),
		} as unknown as SecretStorageService;
		const manager = new CloudflareSessionManager(
			{ ...DEFAULT_SETTINGS, cloudflareAccountId: 'acct' },
			storage,
			vi.fn(async () => {}),
		);

		expect(manager.hasCredentials()).toBe(true);
	});

	it('refreshes the API token when only a refresh token is available', async () => {
		const storage = {
			get: vi.fn((key: string) => {
				if (key === SECRET_KEYS.CLOUDFLARE_API_TOKEN) return '';
				if (key === SECRET_KEYS.CLOUDFLARE_REFRESH_TOKEN) return 'refresh-token';
				return null;
			}),
			set: vi.fn(),
			delete: vi.fn(),
			has: vi.fn(() => false),
		} as unknown as SecretStorageService;
		oauthMocks.refreshAccessToken.mockResolvedValue({
			accessToken: 'new-api-token',
			refreshToken: 'new-refresh-token',
			expiresAt: 12345,
		});

		const persistSettings = vi.fn(async () => {});
		const manager = new CloudflareSessionManager(
			{
				...DEFAULT_SETTINGS,
				cloudflareAccountId: 'acct',
				cloudflareTokenExpiresAt: null,
			},
			storage,
			persistSettings,
		);

		await expect(manager.resolveCredentials()).resolves.toEqual({
			accountId: 'acct',
			apiToken: 'new-api-token',
		});
		expect(oauthMocks.refreshAccessToken).toHaveBeenCalledWith('refresh-token');
		expect((storage.set as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
			SECRET_KEYS.CLOUDFLARE_API_TOKEN,
			'new-api-token',
		);
		expect(persistSettings).toHaveBeenCalled();
	});
});
