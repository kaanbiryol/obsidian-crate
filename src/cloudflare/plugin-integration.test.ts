import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const configureCloudflareAuthorizedDevice = vi.fn();
const generateSecureToken = vi.fn(() => 'device-token');
const hashToken = vi.fn(async () => 'device-token-hash');
const openCloudflareDeploymentModal = vi.fn();

const progress = {
	setWorking: vi.fn(),
	succeed: vi.fn(),
	fail: vi.fn(),
};

async function loadPluginIntegration() {
	vi.doMock('obsidian', () => ({ Notice: vi.fn() }));
	vi.doMock('../sync/plugin-integration', () => ({ configureCloudflareAuthorizedDevice }));
	vi.doMock('../sync/device-token', () => ({ generateSecureToken, hashToken }));
	vi.doMock('../plugin/deviceInfo', () => ({
		getCurrentDeviceName: vi.fn(() => 'Test device'),
		getCurrentPlatformCode: vi.fn(() => 'desktop'),
	}));
	vi.doMock('../ui/cloudflare-deployment-modal', () => ({ openCloudflareDeploymentModal }));
	vi.doMock('../ui/cloudflare-server-picker-modal', () => ({ selectCloudflareServer: vi.fn() }));
	vi.doMock('./embedded-artifacts', () => ({ loadEmbeddedCloudflareArtifacts: vi.fn() }));
	vi.doMock('./http', () => ({ obsidianHttpTransport: vi.fn() }));

	return import('./plugin-integration');
}

function createPlugin(configured = false) {
	const sync = vi.fn<() => Promise<{ success: boolean; errors: string[] }>>(
		async () => ({ success: true, errors: [] }),
	);
	return {
		app: {},
		settings: { deviceId: 'device-id' },
		syncRuntime: { isConfigured: vi.fn(() => configured), sync },
		openSettingsTab: vi.fn(),
		refreshSettingsTab: vi.fn(),
		cloudflareDeploymentService: {
			handleCallback: vi.fn(async () => ({
				accountName: 'Example account',
				workerUrl: 'https://crate.example.workers.dev',
			})),
		},
	};
}

beforeEach(() => {
	configureCloudflareAuthorizedDevice.mockReset();
	generateSecureToken.mockClear();
	hashToken.mockClear();
	openCloudflareDeploymentModal.mockReset();
	openCloudflareDeploymentModal.mockReturnValue(progress);
	progress.setWorking.mockReset();
	progress.succeed.mockReset();
	progress.fail.mockReset();
});

afterEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.doUnmock('obsidian');
	vi.doUnmock('../sync/plugin-integration');
	vi.doUnmock('../sync/device-token');
	vi.doUnmock('../plugin/deviceInfo');
	vi.doUnmock('../ui/cloudflare-deployment-modal');
	vi.doUnmock('../ui/cloudflare-server-picker-modal');
	vi.doUnmock('./embedded-artifacts');
	vi.doUnmock('./http');
});

describe('handleCloudflareOAuthProtocol', () => {
	it('opens settings for visible progress and refreshes them after connecting', async () => {
		configureCloudflareAuthorizedDevice.mockResolvedValue({ success: true });
		const { handleCloudflareOAuthProtocol } = await loadPluginIntegration();
		const plugin = createPlugin();

		await handleCloudflareOAuthProtocol(plugin as never, {
			code: 'authorization-code',
			state: 'oauth-state',
		});

		expect(plugin.openSettingsTab).toHaveBeenCalledTimes(1);
		expect(openCloudflareDeploymentModal).toHaveBeenCalledWith(plugin.app, 'setup');
		expect(plugin.openSettingsTab.mock.invocationCallOrder[0])
			.toBeLessThan(openCloudflareDeploymentModal.mock.invocationCallOrder[0] ?? 0);
		expect(configureCloudflareAuthorizedDevice).toHaveBeenCalledWith(
			plugin,
			'https://crate.example.workers.dev',
			'device-token',
		);
		expect(plugin.refreshSettingsTab).toHaveBeenCalledTimes(2);
		expect(plugin.refreshSettingsTab.mock.invocationCallOrder.at(-1))
			.toBeLessThan(progress.succeed.mock.invocationCallOrder[0] ?? 0);
		expect(plugin.syncRuntime.sync).toHaveBeenCalledTimes(1);
		expect(progress.setWorking).toHaveBeenLastCalledWith(
			'Syncing your vault',
			'Your server is connected. Running the first sync now.',
		);
		expect(progress.succeed).toHaveBeenCalledWith(
			'Crate is ready',
			'Your vault is synced and this device is ready to use.',
		);
	});

	it('refreshes the visible settings after updating an already connected server', async () => {
		const { handleCloudflareOAuthProtocol } = await loadPluginIntegration();
		const plugin = createPlugin(true);

		await handleCloudflareOAuthProtocol(plugin as never, {
			code: 'authorization-code',
			state: 'oauth-state',
		});

		expect(plugin.openSettingsTab).toHaveBeenCalledTimes(1);
		expect(configureCloudflareAuthorizedDevice).not.toHaveBeenCalled();
		expect(plugin.syncRuntime.sync).not.toHaveBeenCalled();
		expect(plugin.refreshSettingsTab).toHaveBeenCalledTimes(1);
		expect(progress.succeed).toHaveBeenCalledWith(
			'Cloudflare server updated',
			'Your Worker and Crate web app are now up to date.',
		);
		expect(openCloudflareDeploymentModal).toHaveBeenCalledWith(plugin.app, 'update');
	});

	it('uses update-specific recovery copy when an existing server update fails', async () => {
		const { handleCloudflareOAuthProtocol } = await loadPluginIntegration();
		const plugin = createPlugin(true);
		plugin.cloudflareDeploymentService.handleCallback.mockRejectedValue(
			new Error('Cloudflare upload failed'),
		);

		await handleCloudflareOAuthProtocol(plugin as never, {
			code: 'authorization-code',
			state: 'oauth-state',
		});

		expect(progress.fail).toHaveBeenCalledWith(
			'Could not update your Cloudflare server',
			'Cloudflare upload failed',
			['Select “Authorize update” in Crate settings to try again.'],
		);
	});

	it('keeps the device connected and shows a retryable warning when the first sync fails', async () => {
		configureCloudflareAuthorizedDevice.mockResolvedValue({ success: true });
		const { handleCloudflareOAuthProtocol } = await loadPluginIntegration();
		const plugin = createPlugin();
		plugin.syncRuntime.sync.mockResolvedValue({
			success: false,
			errors: ['Remote manifest unavailable'],
		});

		await handleCloudflareOAuthProtocol(plugin as never, {
			code: 'authorization-code',
			state: 'oauth-state',
		});

		expect(plugin.syncRuntime.sync).toHaveBeenCalledTimes(1);
		expect(progress.succeed).not.toHaveBeenCalled();
		expect(progress.fail).toHaveBeenCalledWith(
			'Crate is connected with a sync warning',
			'The first sync failed: Remote manifest unavailable',
			['Your device is connected. Select “Sync now” to try again.'],
		);
	});
});
