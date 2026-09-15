import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const configureCloudflareAuthorizedDevice = vi.fn();
const generateSecureToken = vi.fn(() => 'device-token');
const hashToken = vi.fn(async () => 'device-token-hash');
const openCloudflareDeploymentModal = vi.fn();

const progress = {
	close: vi.fn(),
	selectVault: vi.fn(),
	setWorking: vi.fn(),
	succeed: vi.fn(),
	fail: vi.fn(),
};

async function loadPluginIntegration() {
	vi.doMock('./oauth-config', async () => ({ ...await vi.importActual<object>('./oauth-config'), isCloudflareOAuthConfigured: () => true }));
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
		settings: { deviceId: 'device-id', cloudflareDeployment: { accountId: 'account-a' } },
		cloudflareUsageConnection: { withAuthorization: vi.fn() },
		syncRuntime: { isConfigured: vi.fn(() => configured), sync },
		openSettingsTab: vi.fn(),
		getSettingsDocument: vi.fn(() => undefined),
		refreshSettingsTab: vi.fn(),
		cloudflareDeploymentService: {
			startDeployment: vi.fn(),
			deployWithSavedAuthorization: vi.fn(async (..._args: unknown[]) => ({ workerUrl: 'https://crate.example.workers.dev', accountName: 'Example account', deleted: false })),
			pendingIntent: null as null | 'switch' | 'create' | 'reset' | 'delete',
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
	vi.doUnmock('./oauth-config');
	vi.doUnmock('../sync/plugin-integration');
	vi.doUnmock('../sync/device-token');
	vi.doUnmock('../plugin/deviceInfo');
	vi.doUnmock('../ui/cloudflare-deployment-modal');
	vi.doUnmock('../ui/cloudflare-server-picker-modal');
	vi.doUnmock('./embedded-artifacts');
	vi.doUnmock('./http');
});

describe('handleCloudflareOAuthProtocol', () => {
	it.each([null, 'switch', 'create'] as const)('connects the device without transferring vault files for %s', async intent => {
		configureCloudflareAuthorizedDevice.mockResolvedValue({ success: true });
		const { handleCloudflareOAuthProtocol } = await loadPluginIntegration();
		const plugin = createPlugin(intent !== null);
		plugin.cloudflareDeploymentService.pendingIntent = intent;

		await handleCloudflareOAuthProtocol(plugin as never, {
			code: 'authorization-code',
			state: 'oauth-state',
		});

		expect(plugin.openSettingsTab).toHaveBeenCalledTimes(1);
		expect(openCloudflareDeploymentModal).toHaveBeenCalledWith(plugin.app, 'setup', undefined);
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

	it('passes the settings document to the OAuth dialog without waiting for animation frames', async () => {
		const { handleCloudflareOAuthProtocol } = await loadPluginIntegration();
		const plugin = createPlugin();
		const hostDocument = {} as never;
		plugin.getSettingsDocument.mockReturnValue(hostDocument);
		configureCloudflareAuthorizedDevice.mockResolvedValue({ success: true });
		await handleCloudflareOAuthProtocol(plugin as never, { code: 'code', state: 'state' });
		expect(openCloudflareDeploymentModal).toHaveBeenCalledWith(plugin.app, 'setup', hostDocument);
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
		expect(openCloudflareDeploymentModal).toHaveBeenCalledWith(plugin.app, 'update', undefined);
	});

	it('registers and reconnects a fresh device after resetting an already connected server', async () => {
		const { handleCloudflareOAuthProtocol } = await loadPluginIntegration();
		const plugin = createPlugin(true);
		plugin.cloudflareDeploymentService.pendingIntent = 'reset';
		configureCloudflareAuthorizedDevice.mockResolvedValue({ success: true });
		await handleCloudflareOAuthProtocol(plugin as never, { code: 'code', state: 'state' });
		expect(plugin.cloudflareDeploymentService.handleCallback).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tokenHash: 'device-token-hash' }), expect.any(Function), expect.any(Function));
		expect(configureCloudflareAuthorizedDevice).toHaveBeenCalledWith(plugin, 'https://crate.example.workers.dev', 'device-token');
		const report = (plugin.cloudflareDeploymentService.handleCallback.mock.calls[0] as unknown as [unknown, unknown, (message: string) => void])[2];
		report('Checking remote files: 10 checked…');
		expect(progress.setWorking).toHaveBeenCalledWith('Rebuilding Crate server', 'Checking remote files: 10 checked…');
		expect(progress.succeed).toHaveBeenCalledWith('Crate server rebuilt', expect.stringContaining('Crate: Sync now'));
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
			'Server rebuild failed',
			'Crate couldn’t finish rebuilding your Cloudflare server.',
			[expect.stringContaining(resumable ? 'Resume server rebuild' : 'Rebuild server')],
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
			['Select “Update server” in Crate settings to try again.'],
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

it.each(['connect', 'update', 'reset', 'delete'] as const)('uses saved login for %s and connects devices only when needed', async intent => {
	const { startCloudflareDeployment } = await loadPluginIntegration();
	const plugin = createPlugin(intent === 'update' || intent === 'delete');
	plugin.cloudflareDeploymentService.deployWithSavedAuthorization.mockResolvedValue({ workerUrl: 'https://crate.example.workers.dev', accountName: 'Example account', deleted: intent === 'delete' });
	configureCloudflareAuthorizedDevice.mockResolvedValue({ success: true });
	await startCloudflareDeployment(plugin as never, intent === 'connect' ? undefined : intent);
	expect(plugin.cloudflareDeploymentService.deployWithSavedAuthorization.mock.calls[0]?.[0]).toBe(intent);
	expect(plugin.cloudflareDeploymentService.startDeployment).not.toHaveBeenCalled();
	expect(configureCloudflareAuthorizedDevice).toHaveBeenCalledTimes(intent === 'connect' || intent === 'reset' ? 1 : 0);
	expect(progress.succeed).toHaveBeenCalledOnce();
});

it('repairs an unconfigured device with saved authorization and then connects it', async () => {
	const { startCloudflareDeployment } = await loadPluginIntegration();
	const plugin = createPlugin(false);
	configureCloudflareAuthorizedDevice.mockResolvedValue({ success: true });
	await startCloudflareDeployment(plugin as never, 'update');
	expect(plugin.cloudflareDeploymentService.startDeployment).not.toHaveBeenCalled();
	expect(configureCloudflareAuthorizedDevice).toHaveBeenCalledOnce();
});

it.each(['reset', 'delete'] as const)('falls back to the same %s intent only for invalid authorization', async intent => {
	const { startCloudflareDeployment } = await loadPluginIntegration();
	const { CloudflareReauthorizationRequired } = await import('./oauth-client');
	const plugin = createPlugin(true);
	plugin.cloudflareDeploymentService.deployWithSavedAuthorization.mockRejectedValue(new CloudflareReauthorizationRequired());
	await startCloudflareDeployment(plugin as never, intent);
	expect(plugin.cloudflareDeploymentService.startDeployment).toHaveBeenCalledWith(intent);
});

it('does not open Cloudflare for a network failure', async () => {
	const { startCloudflareDeployment } = await loadPluginIntegration();
	const plugin = createPlugin(true);
	plugin.cloudflareDeploymentService.deployWithSavedAuthorization.mockRejectedValue(new Error('Network unavailable'));
	await startCloudflareDeployment(plugin as never, 'delete');
	expect(plugin.cloudflareDeploymentService.startDeployment).not.toHaveBeenCalled();
	expect(progress.fail).toHaveBeenCalledOnce();
});

it.each(['update', 'reset', 'delete'] as const)('shows recovery guidance for an uncertain %s', async intent => {
    const { handleCloudflareOAuthProtocol } = await loadPluginIntegration();
    const { DeploymentRecoveryRequiredError } = await import('./deployment-fence');
    const plugin = createPlugin(true);
    plugin.cloudflareDeploymentService.pendingIntent = intent === 'update' ? null : intent;
    plugin.cloudflareDeploymentService.handleCallback.mockRejectedValue(
        new DeploymentRecoveryRequiredError('Network changed. The deployment fence remains held.'),
    );
    await handleCloudflareOAuthProtocol(plugin as never, { code: 'code', state: 'state' });
    expect(progress.fail).toHaveBeenCalledWith(
        'Server operation needs review',
        expect.stringContaining('Further server changes are blocked'),
        expect.arrayContaining(['Closing this message does not clear the lock.']),
        expect.objectContaining({ technicalDetails: 'Network changed. The deployment fence remains held.' }),
    );
    expect(progress.fail.mock.calls[0]?.[3]).toHaveProperty('action.label', intent === 'update' ? 'Check and recover update' : 'Open settings');
    if (intent === 'delete') expect(JSON.stringify(progress.fail.mock.calls)).toContain('select Resume server deletion');
    else expect(JSON.stringify(progress.fail.mock.calls)).not.toContain('select Resume server deletion');
});

it('does not open another update dialog when the service is busy', async () => {
    const { startCloudflareDeployment } = await loadPluginIntegration();
    const plugin = createPlugin(true);
    Object.assign(plugin.cloudflareDeploymentService, { isBusy: true });
    await startCloudflareDeployment(plugin as never, 'update');
    expect(openCloudflareDeploymentModal).not.toHaveBeenCalled();
    expect(plugin.cloudflareDeploymentService.deployWithSavedAuthorization).not.toHaveBeenCalled();
});
