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
			pendingIntent: null as null | 'reset' | 'delete',
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
	it('connects the device without transferring vault files', async () => {
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
		expect(plugin.refreshSettingsTab).toHaveBeenCalledTimes(1);
		expect(plugin.refreshSettingsTab.mock.invocationCallOrder[0])
			.toBeLessThan(progress.succeed.mock.invocationCallOrder[0] ?? 0);
		expect(plugin.syncRuntime.sync).not.toHaveBeenCalled();
		expect(progress.succeed).toHaveBeenCalledWith(
			'Crate is connected',
			'Connected. Open the command palette and select Crate: Sync now to sync this vault with the server.',
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

	it('registers and reconnects a fresh device after resetting an already connected server', async () => {
		const { handleCloudflareOAuthProtocol } = await loadPluginIntegration();
		const plugin = createPlugin(true);
		plugin.cloudflareDeploymentService.pendingIntent = 'reset';
		configureCloudflareAuthorizedDevice.mockResolvedValue({ success: true });
		await handleCloudflareOAuthProtocol(plugin as never, { code: 'code', state: 'state' });
		expect(plugin.cloudflareDeploymentService.handleCallback).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tokenHash: 'device-token-hash' }), expect.any(Function));
		expect(configureCloudflareAuthorizedDevice).toHaveBeenCalledWith(plugin, 'https://crate.example.workers.dev', 'device-token');
		const report = (plugin.cloudflareDeploymentService.handleCallback.mock.calls[0] as unknown as [unknown, unknown, (message: string) => void])[2];
		report('Checking remote files: 10 checked…');
		expect(progress.setWorking).toHaveBeenCalledWith('Resetting Crate server', 'Checking remote files: 10 checked…');
		expect(progress.succeed).toHaveBeenCalledWith('Crate server reset', expect.stringContaining('Crate: Sync now'));
		expect(plugin.syncRuntime.sync).not.toHaveBeenCalled();
	});

	it.each([false, true])('offers the saved reset recovery action (resumable: %s)', async (resumable) => {
		const { handleCloudflareOAuthProtocol } = await loadPluginIntegration();
		const plugin = createPlugin(true);
		Object.assign(plugin.settings, { cloudflareDeployment: { reset: resumable ? {} : undefined } });
		plugin.cloudflareDeploymentService.pendingIntent = 'reset';
		plugin.cloudflareDeploymentService.handleCallback.mockRejectedValue(new Error('Namespace listing incomplete'));
		await handleCloudflareOAuthProtocol(plugin as never, { code: 'code', state: 'state' });
		expect(progress.fail).toHaveBeenCalledWith(
			'Server reset failed',
			'Crate couldn’t finish resetting your Cloudflare server.',
			[expect.stringContaining(resumable ? 'Resume server reset' : 'Reset server')],
			expect.objectContaining({ technicalDetails: 'Namespace listing incomplete' }),
		);
		const options = progress.fail.mock.calls[0]![3] as { action: { onClick: () => void } };
		options.action.onClick();
		expect(plugin.openSettingsTab).toHaveBeenCalledTimes(2);
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

	it('finishes deletion without connecting this device or uploading files', async () => {
		const { handleCloudflareOAuthProtocol } = await loadPluginIntegration();
		const plugin = createPlugin(true);
		plugin.cloudflareDeploymentService.pendingIntent = 'delete';
		plugin.cloudflareDeploymentService.handleCallback.mockResolvedValue({ workerUrl: '', accountName: 'Personal', deleted: true } as never);
		await handleCloudflareOAuthProtocol(plugin as never, { code: 'code', state: 'state' });
		expect(generateSecureToken).not.toHaveBeenCalled();
		expect(configureCloudflareAuthorizedDevice).not.toHaveBeenCalled();
		expect(plugin.syncRuntime.sync).not.toHaveBeenCalled();
		expect(progress.succeed).toHaveBeenCalledWith('Crate server deleted', expect.stringContaining('local vault files are kept'));
	});

	it.each(['success', 'failure'] as const)('ignores a late deployment %s after plugin unload', async outcome => {
		const { handleCloudflareOAuthProtocol } = await loadPluginIntegration();
		const { endPluginLifecycle } = await import('../plugin/lifecycle-state');
		const plugin = createPlugin();
		let release!: () => void;
		plugin.cloudflareDeploymentService.handleCallback.mockImplementation(async () => {
			await new Promise<void>(resolve => { release = resolve; });
			if (outcome === 'failure') throw new Error('Interrupted');
			return { workerUrl: 'https://crate.example.workers.dev', accountName: 'Personal' };
		});
		const running = handleCloudflareOAuthProtocol(plugin as never, { code: 'code', state: 'state' });
		await vi.waitFor(() => expect(release).toBeTypeOf('function'));
		endPluginLifecycle(plugin as never);
		release();
		await running;
		expect(configureCloudflareAuthorizedDevice).not.toHaveBeenCalled();
		expect(plugin.refreshSettingsTab).not.toHaveBeenCalled();
		expect(progress.succeed).not.toHaveBeenCalled();
		expect(progress.fail).not.toHaveBeenCalled();
	});

	it('does not dispatch authorization after unloading during device credential hashing', async () => {
		const { handleCloudflareOAuthProtocol } = await loadPluginIntegration();
		const { endPluginLifecycle } = await import('../plugin/lifecycle-state');
		const plugin = createPlugin();
		hashToken.mockImplementationOnce(async () => {
			endPluginLifecycle(plugin as never);
			return 'hash';
		});
		await handleCloudflareOAuthProtocol(plugin as never, { code: 'code', state: 'state' });
		expect(plugin.cloudflareDeploymentService.handleCallback).not.toHaveBeenCalled();
		expect(configureCloudflareAuthorizedDevice).not.toHaveBeenCalled();
	});

	it('ignores connection completion after plugin unload', async () => {
		const { handleCloudflareOAuthProtocol } = await loadPluginIntegration();
		const { endPluginLifecycle } = await import('../plugin/lifecycle-state');
		const plugin = createPlugin();
		configureCloudflareAuthorizedDevice.mockImplementationOnce(async () => {
			endPluginLifecycle(plugin as never);
			return { success: true };
		});
		await handleCloudflareOAuthProtocol(plugin as never, { code: 'code', state: 'state' });
		expect(plugin.refreshSettingsTab).not.toHaveBeenCalled();
		expect(progress.succeed).not.toHaveBeenCalled();
	});

});
