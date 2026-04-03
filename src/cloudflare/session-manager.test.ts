import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretStorageService } from '../plugin/secret-storage';
import { DEFAULT_SETTINGS, SECRET_KEYS } from '../plugin/types';

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
		const setMock = vi.fn();
		const storage = {
			get: vi.fn((key: string) => {
				if (key === SECRET_KEYS.CLOUDFLARE_API_TOKEN) return '';
				if (key === SECRET_KEYS.CLOUDFLARE_REFRESH_TOKEN) return 'refresh-token';
				return null;
			}),
			set: setMock,
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
		expect(oauthMocks.refreshAccessToken.mock.calls).toEqual([['refresh-token']]);
		expect(setMock).toHaveBeenCalledWith(
			SECRET_KEYS.CLOUDFLARE_API_TOKEN,
			'new-api-token',
		);
		expect(persistSettings).toHaveBeenCalled();
	});

	it('rejects attempts to persist blank credentials', async () => {
		const setMock = vi.fn();
		const storage = {
			set: setMock,
			delete: vi.fn(),
			get: vi.fn(() => null),
			has: vi.fn(() => false),
		} as unknown as SecretStorageService;
		const manager = new CloudflareSessionManager(
			{ ...DEFAULT_SETTINGS },
			storage,
			vi.fn(async () => {}),
		);

		await expect(manager.saveCredentials(' ', 'token')).rejects.toThrow('Cloudflare account ID is required');
		await expect(manager.saveCredentials('acct', '   ')).rejects.toThrow('Cloudflare API token is required');
		expect(setMock).not.toHaveBeenCalled();
	});
});
