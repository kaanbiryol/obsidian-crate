import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { endPluginLifecycle } from '../lifecycle-state';
import { DEFAULT_SETTINGS } from '../settings';
import { SyncApiClient } from '../../sync/worker-api/client';
import { configureCloudflareAuthorizedDevice } from './connection';

// An unencrypted server, so a test can send the seeding request through the real client.
const sent = vi.hoisted(() => [] as Array<{ url: string; method?: string; body?: unknown }>);
vi.mock('obsidian', async importOriginal => ({
	...await importOriginal<object>(),
	requestUrl: async (request: { url: string; method?: string; body?: unknown }) => {
		sent.push(request);
		const text = JSON.stringify(request.url.endsWith('/.well-known/crate')
			? { service: 'crate', serverVersion: 'test', serverRevision: 4, reminderOperationDay: 20_000, protocol: { current: 1, oldestCompatible: 1 }, capabilities: ['e2ee-v1', 'settings-v1'] }
			: request.url.endsWith('/encryption') ? { encryption: null } : { success: true, settingsVersion: 'seeded' });
		return { status: 200, headers: { 'X-Crate-Encryption-State': 'off' }, text, arrayBuffer: new TextEncoder().encode(text).buffer };
	},
}));

const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../ui/plugin/confirmation-modal', () => ({ openConfirmationModal: confirm }));

const remote ={ ignorePatterns: ['remote-pattern'], syncInterval: 60, pushEnabled: true };

function plugin() {
	return {
		settings: { ...DEFAULT_SETTINGS },
		writeSettings: vi.fn(async function (this: { settings: object }, update: object) { Object.assign(this.settings, update); }),
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
		hasFiles: vi.spyOn(SyncApiClient.prototype, 'hasFiles').mockResolvedValue(false),
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
	expect(owner.writeSettings).toHaveBeenCalledExactlyOnceWith(remote);
	expect(owner.syncRuntime.updateSyncSettings).toHaveBeenCalledOnce();
	expect(owner.syncRuntime.applyInfrastructureConfig.mock.invocationCallOrder[0]).toBeLessThan(owner.writeSettings.mock.invocationCallOrder[0]!);
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
	expect(owner.writeSettings).not.toHaveBeenCalled();
});

it.each([[null, true], ['previous-vault', false]] as const)('seeds an unencrypted server in plaintext only when this vault never synced encrypted (%s)', async (encryptedVaultId, seeded) => {
	vi.stubGlobal('window', { setTimeout, clearTimeout });
	try {
		sent.length = 0;
		const owner = plugin();
		Object.assign(owner.settings, { encryptedVaultId, ignorePatterns: ['Private project/**'] });
		server.sharedSettings.mockResolvedValue({ settings: null, settingsVersion: null });
		server.createSettings.mockRestore();
		await expect(configureCloudflareAuthorizedDevice(owner as never, 'https://crate.example.workers.dev', 'token')).resolves.toEqual({ success: true });
		expect(sent.some(request => request.method === 'PUT' && String(request.body).includes('Private project/**'))).toBe(seeded);
	} finally { vi.unstubAllGlobals(); }
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
	expect(owner.writeSettings).not.toHaveBeenCalled();
	expect(owner.syncRuntime.pushSharedSettingsBestEffort).not.toHaveBeenCalled();
});

it('does not read shared settings from an encrypted server before its keys are available', async () => {
	const owner = plugin();
	server.encryption.mockResolvedValue({ mode: 'active' } as never);
	await configureCloudflareAuthorizedDevice(owner as never, 'https://crate.example.workers.dev', 'token');
	expect(server.sharedSettings).not.toHaveBeenCalled();
	expect(owner.syncRuntime.applyInfrastructureConfig).toHaveBeenCalledOnce();
	expect(owner.settings.ignorePatterns).toEqual(DEFAULT_SETTINGS.ignorePatterns);
	expect(owner.writeSettings).not.toHaveBeenCalled();
});

it('asks before joining a server with files and saves the replacement with the connection', async () => {
	const owner = plugin();
	server.hasFiles.mockResolvedValue(true);
	await configureCloudflareAuthorizedDevice(owner as never, 'https://crate.example.workers.dev', 'token');
	expect(confirm).toHaveBeenCalledOnce();
	expect(owner.syncRuntime.applyInfrastructureConfig).toHaveBeenCalledWith(
		{ workerUrl: 'https://crate.example.workers.dev', authToken: 'token', replaceVault: true }, expect.any(AbortSignal));
});

it('does not connect when the replacement is cancelled', async () => {
	const owner = plugin();
	server.hasFiles.mockResolvedValue(true);
	confirm.mockResolvedValueOnce(false);
	await expect(configureCloudflareAuthorizedDevice(owner as never, 'https://crate.example.workers.dev', 'token'))
		.rejects.toMatchObject({ code: 'replace-cancelled' });
	expect(owner.syncRuntime.applyInfrastructureConfig).not.toHaveBeenCalled();
});

it('connects to an empty server, or reconnects, without asking', async () => {
	const owner = plugin();
	await configureCloudflareAuthorizedDevice(owner as never, 'https://crate.example.workers.dev', 'token');
	server.hasFiles.mockResolvedValue(true);
	await configureCloudflareAuthorizedDevice(owner as never, 'https://crate.example.workers.dev', 'token', { workerUrl: 'https://crate.example.workers.dev', authToken: 'old' });
	expect(confirm).not.toHaveBeenCalled();
	for (const [config] of owner.syncRuntime.applyInfrastructureConfig.mock.calls as unknown as Array<[object]>) expect(config).not.toHaveProperty('replaceVault');
});
