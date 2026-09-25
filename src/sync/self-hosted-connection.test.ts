import { beforeEach, describe, expect, it, vi } from 'vitest';
import type CratePlugin from '../plugin/CratePlugin';
import { endPluginLifecycle } from '../plugin/lifecycle-state';
import { connectSelfHostedServer, updateSelfHostedServerAddress } from './self-hosted-connection';

const api = vi.hoisted(() => ({
	setAbortSignal: vi.fn(), testConnection: vi.fn(), listTokens: vi.fn(), getSharedSettings: vi.fn(),
}));
const exchange = vi.hoisted(() => vi.fn());
vi.mock('./self-hosted-pairing', () => ({ exchangeSelfHostedPairingCode: exchange }));
vi.mock('./api', () => ({ SyncApiClient: class { constructor() { return api; } } }));

function plugin() {
	return {
		settings: { cloudflareDeployment: null, workerUrl: 'https://previous.trycloudflare.com' },
		secretStorage: { get: vi.fn(() => token) },
		cloudflareDeploymentService: { isBusy: false, pendingIntent: null },
		clearSettingsUiState: vi.fn(), saveSettings: vi.fn(),
		syncRuntime: { isConfigured: vi.fn(() => false), applyInfrastructureConfig: vi.fn(), updateSyncSettings: vi.fn() },
	};
}
const token = 'a'.repeat(64);
beforeEach(() => {
	vi.resetAllMocks();
	api.testConnection.mockResolvedValue({ success: true });
	api.listTokens.mockResolvedValue({ tokens: [] });
	api.getSharedSettings.mockResolvedValue({ settings: null });
});

describe('self-hosted server connection', () => {
	it('exchanges a single-use code before verifying and saving its device token', async () => {
		const owner = plugin();
		exchange.mockResolvedValue(token);
		const code = `crate-pair-${'b'.repeat(64)}`;
		await connectSelfHostedServer(owner as unknown as CratePlugin, 'https://crate.example', code);
		expect(exchange).toHaveBeenCalledWith('https://crate.example', code, expect.any(AbortSignal));
		expect(owner.syncRuntime.applyInfrastructureConfig).toHaveBeenCalledWith({ workerUrl: 'https://crate.example', authToken: token }, expect.any(AbortSignal));
	});
	it('verifies a new tunnel address with the saved credential before updating', async () => {
		const owner = plugin();
		owner.syncRuntime.isConfigured.mockReturnValue(true);
		await updateSelfHostedServerAddress(owner as unknown as CratePlugin, 'https://next.trycloudflare.com');
		expect(api.listTokens).toHaveBeenCalledOnce();
		expect(owner.syncRuntime.applyInfrastructureConfig).toHaveBeenCalledWith(
			{ workerUrl: 'https://next.trycloudflare.com', authToken: token }, expect.any(AbortSignal),
			{ workerUrl: 'https://previous.trycloudflare.com', authToken: token });
	});
	it('keeps the old connection when a new tunnel rejects the saved token', async () => {
		const owner = plugin();
		owner.syncRuntime.isConfigured.mockReturnValue(true);
		api.listTokens.mockRejectedValue(new Error('Unauthorized'));
		await expect(updateSelfHostedServerAddress(owner as unknown as CratePlugin, 'https://next.trycloudflare.com')).rejects.toThrow('Unauthorized');
		expect(owner.syncRuntime.applyInfrastructureConfig).not.toHaveBeenCalled();
	});
	it('validates vault access before storing credentials through the existing lifecycle', async () => {
		const owner = plugin();
		await connectSelfHostedServer(owner as unknown as CratePlugin, ' http://localhost:8787/ ', token);
		expect(api.listTokens).toHaveBeenCalledOnce();
		expect(owner.syncRuntime.applyInfrastructureConfig).toHaveBeenCalledWith({ workerUrl: 'http://localhost:8787', authToken: token }, expect.any(AbortSignal));
		expect(api.listTokens.mock.invocationCallOrder[0]).toBeLessThan(owner.syncRuntime.applyInfrastructureConfig.mock.invocationCallOrder[0]!);
	});
	it('leaves settings untouched for invalid credentials or reminder-only tokens', async () => {
		const owner = plugin();
		api.listTokens.mockRejectedValue(new Error('Unauthorized'));
		await expect(connectSelfHostedServer(owner as unknown as CratePlugin, 'https://crate.example', token)).rejects.toThrow('Unauthorized');
		expect(owner.syncRuntime.applyInfrastructureConfig).not.toHaveBeenCalled();
		expect(owner.clearSettingsUiState).not.toHaveBeenCalled();
	});
	it('rejects an incompatible server before inspecting or changing settings', async () => {
		const owner = plugin();
		api.testConnection.mockResolvedValue({ success: false, error: 'Incompatible protocol' });
		await expect(connectSelfHostedServer(owner as unknown as CratePlugin, 'https://crate.example', token)).rejects.toThrow('Incompatible');
		expect(api.listTokens).not.toHaveBeenCalled();
		expect(owner.syncRuntime.applyInfrastructureConfig).not.toHaveBeenCalled();
	});
	it('does not overwrite an existing connection or an in-progress Cloudflare setup', async () => {
		const owner = plugin();
		owner.syncRuntime.isConfigured.mockReturnValue(true);
		await expect(connectSelfHostedServer(owner as unknown as CratePlugin, 'https://crate.example', token)).rejects.toThrow('Disconnect');
		owner.syncRuntime.isConfigured.mockReturnValue(false);
		owner.cloudflareDeploymentService.isBusy = true;
		await expect(connectSelfHostedServer(owner as unknown as CratePlugin, 'https://crate.example', token)).rejects.toThrow('Cloudflare');
		expect(api.testConnection).not.toHaveBeenCalled();
	});
	it('rechecks connection ownership and plugin lifetime after network requests', async () => {
		const owner = plugin();
		api.getSharedSettings.mockImplementation(async () => {
			endPluginLifecycle(owner as unknown as CratePlugin);
			return { settings: null };
		});
		await expect(connectSelfHostedServer(owner as unknown as CratePlugin, 'https://crate.example', token)).rejects.toThrow();
		expect(owner.syncRuntime.applyInfrastructureConfig).not.toHaveBeenCalled();
	});
	it('rejects insecure network addresses before sending the token', async () => {
		await expect(connectSelfHostedServer(plugin() as unknown as CratePlugin, 'http://192.168.1.2', token)).rejects.toThrow('HTTPS');
		expect(api.testConnection).not.toHaveBeenCalled();
	});
});


it('repairs a self-hosted connection without disconnecting first', async () => {
	const owner = plugin();
	owner.syncRuntime.isConfigured.mockReturnValue(true);
	await connectSelfHostedServer(owner as unknown as CratePlugin, owner.settings.workerUrl, token, true);
	expect(api.listTokens).toHaveBeenCalledOnce();
	expect(owner.syncRuntime.applyInfrastructureConfig).toHaveBeenCalledWith(
		{ workerUrl: owner.settings.workerUrl, authToken: token }, expect.any(AbortSignal),
		{ workerUrl: owner.settings.workerUrl, authToken: token });
});

it('preserves a self-hosted connection when replacement pairing fails', async () => {
	const owner = plugin();
	owner.syncRuntime.isConfigured.mockReturnValue(true);
	exchange.mockRejectedValue(new Error('Pairing code expired'));
	await expect(connectSelfHostedServer(owner as unknown as CratePlugin, owner.settings.workerUrl, `crate-pair-${'b'.repeat(64)}`, true)).rejects.toThrow('expired');
	expect(owner.syncRuntime.applyInfrastructureConfig).not.toHaveBeenCalled();
});
