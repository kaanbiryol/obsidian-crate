import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { endPluginLifecycle } from '../../plugin/lifecycle-state';
import { DEFAULT_SETTINGS } from '../../plugin/settings';
import { SyncApiClient } from '../worker-api/client';
import { configureCloudflareAuthorizedDevice } from './cloudflare-connection';

const remote = { ignorePatterns: ['remote-pattern'], syncInterval: 60, pushEnabled: true };

function plugin() {
	return {
		settings: { ...DEFAULT_SETTINGS },
		saveSettings: vi.fn(async () => {}),
		syncRuntime: {
			applyInfrastructureConfig: vi.fn(async () => {}),
			updateSyncSettings: vi.fn(),
			pushSharedSettingsBestEffort: vi.fn(),
			testConnection: vi.fn(async () => ({ success: true })),
		},
	};
}

function spyOnServer() {
	return {
		encryption: vi.spyOn(SyncApiClient.prototype, 'getEncryptionState').mockResolvedValue(null),
		sharedSettings: vi.spyOn(SyncApiClient.prototype, 'getSharedSettings').mockResolvedValue({ settings: remote, settingsVersion: 'version' }),
		createSettings: vi.spyOn(SyncApiClient.prototype, 'createSharedSettings').mockResolvedValue({ success: true, settingsVersion: 'seeded' }),
	};
}
let server: ReturnType<typeof spyOnServer>;
beforeEach(() => { server = spyOnServer(); });
afterEach(() => vi.restoreAllMocks());

it('does not apply remote settings or connect after unloading during the shared settings request', async () => {
	const owner = plugin();
	server.sharedSettings.mockImplementation(async () => {
		endPluginLifecycle(owner as never);
		return { settings: remote, settingsVersion: 'version' };
	});
	await expect(configureCloudflareAuthorizedDevice(owner as never, 'https://crate.example.workers.dev', 'token'))
		.rejects.toMatchObject({ name: 'AbortError' });
	expect(owner.settings.ignorePatterns).toEqual(DEFAULT_SETTINGS.ignorePatterns);
	expect(owner.syncRuntime.applyInfrastructureConfig).not.toHaveBeenCalled();
	expect(owner.syncRuntime.pushSharedSettingsBestEffort).not.toHaveBeenCalled();
	expect(owner.syncRuntime.testConnection).not.toHaveBeenCalled();
});

it('applies remote shared settings only after the connection is saved', async () => {
	const owner = plugin();
	owner.syncRuntime.applyInfrastructureConfig.mockImplementation(async () => {
		expect(owner.settings.ignorePatterns).toEqual(DEFAULT_SETTINGS.ignorePatterns);
	});
	await expect(configureCloudflareAuthorizedDevice(owner as never, 'https://crate.example.workers.dev', 'token')).resolves.toEqual({ success: true });
	expect(owner.settings).toMatchObject(remote);
	expect(owner.saveSettings).toHaveBeenCalledOnce();
	expect(owner.syncRuntime.updateSyncSettings).toHaveBeenCalledOnce();
	expect(owner.syncRuntime.applyInfrastructureConfig.mock.invocationCallOrder[0]).toBeLessThan(owner.saveSettings.mock.invocationCallOrder[0]!);
});

function expectNoSettingsWrite(owner: ReturnType<typeof plugin>) {
	expect(server.createSettings).not.toHaveBeenCalled();
	expect(owner.syncRuntime.pushSharedSettingsBestEffort).not.toHaveBeenCalled();
}

it('does not push over shared settings the server already has', async () => {
	const owner = plugin();
	await configureCloudflareAuthorizedDevice(owner as never, 'https://crate.example.workers.dev', 'token');
	expect(owner.settings).toMatchObject(remote);
	expectNoSettingsWrite(owner);
});

it('does not push this device\'s settings when the shared settings read fails', async () => {
	const owner = plugin();
	server.sharedSettings.mockRejectedValue(new Error('Server unavailable'));
	await expect(configureCloudflareAuthorizedDevice(owner as never, 'https://crate.example.workers.dev', 'token')).resolves.toEqual({ success: true });
	expect(owner.syncRuntime.applyInfrastructureConfig).toHaveBeenCalledOnce();
	expect(owner.settings.ignorePatterns).toEqual(DEFAULT_SETTINGS.ignorePatterns);
	expectNoSettingsWrite(owner);
});

it('does not push settings to an encrypted server it could not read', async () => {
	const owner = plugin();
	server.encryption.mockResolvedValue({ mode: 'active' } as never);
	await configureCloudflareAuthorizedDevice(owner as never, 'https://crate.example.workers.dev', 'token');
	expectNoSettingsWrite(owner);
});

it('seeds a fresh deployment with this device\'s shared settings after connecting', async () => {
	const owner = plugin();
	server.sharedSettings.mockResolvedValue({ settings: null, settingsVersion: null });
	await expect(configureCloudflareAuthorizedDevice(owner as never, 'https://crate.example.workers.dev', 'token')).resolves.toEqual({ success: true });
	expect(server.createSettings).toHaveBeenCalledExactlyOnceWith({
		ignorePatterns: DEFAULT_SETTINGS.ignorePatterns, syncInterval: DEFAULT_SETTINGS.syncInterval, pushEnabled: DEFAULT_SETTINGS.pushEnabled,
	});
	expect(owner.syncRuntime.applyInfrastructureConfig.mock.invocationCallOrder[0]).toBeLessThan(server.createSettings.mock.invocationCallOrder[0]!);
	expect(owner.syncRuntime.pushSharedSettingsBestEffort).not.toHaveBeenCalled();
	expect(owner.saveSettings).not.toHaveBeenCalled();
});

it('keeps the connection when seeding loses to another device', async () => {
	const owner = plugin();
	server.sharedSettings.mockResolvedValue({ settings: null, settingsVersion: null });
	server.createSettings.mockRejectedValue(new Error('Shared settings changed on another device'));
	await expect(configureCloudflareAuthorizedDevice(owner as never, 'https://crate.example.workers.dev', 'token')).resolves.toEqual({ success: true });
	expect(owner.syncRuntime.pushSharedSettingsBestEffort).not.toHaveBeenCalled();
});

it('keeps the current connection settings when switching servers fails', async () => {
	const owner = plugin();
	owner.syncRuntime.applyInfrastructureConfig.mockRejectedValue(new Error('Resume the encrypted folder move before changing this device’s connection.'));
	await expect(configureCloudflareAuthorizedDevice(owner as never, 'https://crate.example.workers.dev', 'token')).rejects.toThrow('Resume the encrypted folder move');
	expect(owner.settings.ignorePatterns).toEqual(DEFAULT_SETTINGS.ignorePatterns);
	expect(owner.saveSettings).not.toHaveBeenCalled();
	expect(owner.syncRuntime.pushSharedSettingsBestEffort).not.toHaveBeenCalled();
});

it('does not read shared settings from an encrypted server before its keys are available', async () => {
	const owner = plugin();
	server.encryption.mockResolvedValue({ mode: 'active' } as never);
	await configureCloudflareAuthorizedDevice(owner as never, 'https://crate.example.workers.dev', 'token');
	expect(server.sharedSettings).not.toHaveBeenCalled();
	expect(owner.syncRuntime.applyInfrastructureConfig).toHaveBeenCalledOnce();
	expect(owner.settings.ignorePatterns).toEqual(DEFAULT_SETTINGS.ignorePatterns);
	expect(owner.saveSettings).not.toHaveBeenCalled();
});
