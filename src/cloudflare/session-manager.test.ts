import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretStorageService } from '../plugin/secret-storage';
import { DEFAULT_SETTINGS, SECRET_KEYS } from '../plugin/types';
import { CloudflareSessionManager } from './session-manager';

describe('CloudflareSessionManager', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('reports credentials when account ID and API token exist', () => {
		const storage = {
			has: vi.fn((key: string) => key === SECRET_KEYS.CLOUDFLARE_API_TOKEN),
		} as unknown as SecretStorageService;
		const manager = new CloudflareSessionManager(
			{ ...DEFAULT_SETTINGS, cloudflareAccountId: 'acct' },
			storage,
			vi.fn(async () => {}),
		);

		expect(manager.hasCredentials()).toBe(true);
	});

	it('reports no credentials when account ID is missing', () => {
		const storage = {
			has: vi.fn(() => true),
		} as unknown as SecretStorageService;
		const manager = new CloudflareSessionManager(
			{ ...DEFAULT_SETTINGS, cloudflareAccountId: '' },
			storage,
			vi.fn(async () => {}),
		);

		expect(manager.hasCredentials()).toBe(false);
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

	it('saves and persists credentials', async () => {
		const setMock = vi.fn();
		const persistSettings = vi.fn(async () => {});
		const settings = { ...DEFAULT_SETTINGS };
		const storage = {
			set: setMock,
		} as unknown as SecretStorageService;
		const manager = new CloudflareSessionManager(settings, storage, persistSettings);

		await manager.saveCredentials('acct-123', 'token-abc');

		expect(settings.cloudflareAccountId).toBe('acct-123');
		expect(setMock).toHaveBeenCalledWith(SECRET_KEYS.CLOUDFLARE_API_TOKEN, 'token-abc');
		expect(persistSettings).toHaveBeenCalled();
	});
});
