import release from '../../cloudflare/server-release.json';
import type { DevelopmentBuild } from '../../cloudflare/server-build';
import type { ConfirmationModalOptions } from '../confirmation-modal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	FakeElement,
	MockSetting,
	createObsidianUiModule,
	resetObsidianUiMocks,
} from '../../test/fakes/obsidian-ui';

const openConfirmationModal = vi.fn();
const startCloudflareDeployment = vi.fn();
const checkAndRecoverUpdate = vi.fn();
const openServerRestore = vi.fn();
const openExternalBrowserModal = vi.fn();
const embeddedArtifact = {
	version: '0.1.0',
	fingerprint: 'f'.repeat(64),
	development: undefined as DevelopmentBuild | undefined,
};

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function loadConfigSectionModule(mobile = false) {
	vi.doMock('obsidian', () => ({ ...createObsidianUiModule(), Platform: { isMobile: mobile } }));
	vi.doMock('../../cloudflare/restore/ui', () => ({ openServerRestore }));
	vi.doMock('../../cloudflare/deployment-recovery-ui', () => ({ checkAndRecoverUpdate }));
	vi.doMock('../../cloudflare/plugin-integration', () => ({ startCloudflareDeployment }));
	vi.doMock('../../cloudflare/embedded-artifacts', () => ({
		EMBEDDED_CLOUDFLARE_ARTIFACT: embeddedArtifact,
	}));
	vi.doMock('../confirmation-modal', () => ({ openConfirmationModal }));
	vi.doMock('../external-browser-modal', () => ({ openExternalBrowserModal }));
	vi.doMock('./section-helpers', () => ({ createSettingsSectionHeading: vi.fn(), createSettingsDisclosure: (container: FakeElement) => container.createDiv() }));

	return import('./config-section');
}

function getSettingByName(name: string): MockSetting {
	const setting = MockSetting.instances.find(instance => instance.nameEl.textContent === name);
	if (!setting) throw new Error(`Setting not found: ${name}`);
	return setting;
}

beforeEach(() => {
	embeddedArtifact.development = undefined;
	resetObsidianUiMocks();
	openConfirmationModal.mockReset();
	startCloudflareDeployment.mockReset();
	openExternalBrowserModal.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
	vi.clearAllMocks();
	vi.doUnmock('obsidian');
	vi.doUnmock('../../cloudflare/plugin-integration');
	vi.doUnmock('../../cloudflare/deployment-recovery-ui');
	vi.doUnmock('../../cloudflare/restore/ui');
	vi.doUnmock('../../cloudflare/embedded-artifacts');
	vi.doUnmock('../confirmation-modal');
	vi.doUnmock('../external-browser-modal');
	vi.doUnmock('./section-helpers');
});

describe('renderConfigSection integration', () => {
	it('offers a tappable dashboard link on mobile', async () => {
		const { renderServerSection } = await loadConfigSectionModule(true);
		const plugin = {
			app: {},
			manifest: { version: '0.3.0' },
			settings: { cloudflareDeployment: { accountId: 'account', d1DatabaseId: 'database', vaultName: 'Vault' }, workerUrl: 'https://worker.example.com' },
			syncRuntime: { getCachedVersionInfo: () => undefined, isConfigured: () => true, getVersionInfo: vi.fn() },
		};
		const openWindow = vi.fn();
		vi.stubGlobal('window', { open: openWindow });
		renderServerSection({ containerEl: new FakeElement('div') as never, plugin: plugin as never, rerender: vi.fn() });
		getSettingByName('Cloudflare dashboard').buttons[0]?.click();
		expect(openExternalBrowserModal).toHaveBeenCalledWith(plugin.app, 'https://dash.cloudflare.com/', expect.objectContaining({ linkText: 'Open Cloudflare' }));
		expect(openWindow).not.toHaveBeenCalled();
	});

	it('shows local management guidance without Cloudflare dashboard or update controls', async () => {
		const { renderServerSection, renderServerUpdateNotice } = await loadConfigSectionModule();
		const context = {
			containerEl: new FakeElement('div') as never,
			plugin: { secretStorage: { get: () => null }, manifest: { version: '0.3.0' }, settings: { cloudflareDeployment: null, workerUrl: 'http://localhost:8787' },
				syncRuntime: { getCachedVersionInfo: () => undefined, isConfigured: () => true, getVersionInfo: vi.fn(async () => ({ serverRevision: 56 })) },
			} as never,
			rerender: vi.fn(),
		};
		renderServerSection(context);
		renderServerUpdateNotice(context);
		await flushMicrotasks();
		const names = MockSetting.instances.map(setting => setting.nameEl.textContent);
		expect(names).toContain('Self-hosted server');
		expect(names).not.toContain('Cloudflare dashboard');
		expect(names).not.toContain('Cloudflare update available');
	});

	it('offers Cloudflare and a self-hosted connection on an unconfigured device', async () => {
		const { renderConfigSection } = await loadConfigSectionModule();

		renderConfigSection({
			containerEl: new FakeElement('div') as never,
			plugin: { secretStorage: { get: () => null }, manifest: { version: '0.2.0' },
				settings: { cloudflareDeployment: null },
				syncRuntime: { getCachedVersionInfo: () => undefined, getVersionInfo: vi.fn(async () => ({ serverRevision: 7, deploymentFingerprint: embeddedArtifact.fingerprint })), isConfigured: vi.fn(() => false) },
			} as never,
			rerender: vi.fn(),
		});

		expect(MockSetting.instances.map(setting => setting.nameEl.textContent)).toEqual([
			'Connect with Cloudflare',
			'Server address', 'Pairing code or access token', 'Connect to your server',
		]);
		expect(getSettingByName('Connect with Cloudflare').descEl.textContent).toBe(
			'Sign in to connect to an existing Crate server or create one in your Cloudflare account. Cloudflare plan limits and usage charges may apply.',
		);
		getSettingByName('Connect with Cloudflare').buttons[0]?.click();
		expect(startCloudflareDeployment).toHaveBeenCalledTimes(1);
	});

	it('offers reconnect for a remembered server on a disconnected device', async () => {
		const { renderConfigSection } = await loadConfigSectionModule();
		const plugin = { secretStorage: { get: () => null }, manifest: { version: '0.2.0' },
			settings: { cloudflareDeployment: { accountId: 'account', d1DatabaseId: 'database' } },
			syncRuntime: { getCachedVersionInfo: () => undefined, getVersionInfo: vi.fn(async () => ({ serverRevision: 7, deploymentFingerprint: embeddedArtifact.fingerprint })), isConfigured: () => false },
		};
		renderConfigSection({ containerEl: new FakeElement('div') as never, plugin: plugin as never, rerender: vi.fn() });
		expect(MockSetting.instances.map(setting => setting.nameEl.textContent)).toEqual(['Reconnect', 'Server backup recovery']);
		const reconnect = getSettingByName('Reconnect');
		expect(reconnect.descEl.textContent).toContain('using your saved Cloudflare login');
		reconnect.buttons[0]!.click();
		expect(startCloudflareDeployment).toHaveBeenCalledExactlyOnceWith(plugin);
	});

	it.each([true, false])('forgets a server only after confirmation (%s)', async confirmed => {
		await loadConfigSectionModule();
		const { renderForgetServerSetting } = await import('./server-selection-setting');
		const saved = { accountId: 'account', d1DatabaseId: 'database' };
		const plugin = { secretStorage: { get: () => null }, manifest: { version: '0.2.0' },
			app: {}, settings: { cloudflareDeployment: saved as typeof saved | null },
			cloudflareDeploymentService: { cancelPendingDeployment: vi.fn() },
			clearSettingsUiState: vi.fn(),
			syncRuntime: { getCachedVersionInfo: () => undefined, getVersionInfo: vi.fn(async () => ({ serverRevision: 7, deploymentFingerprint: embeddedArtifact.fingerprint })), isConfigured: () => false, clearSyncConfiguration: vi.fn(async () => {}) },
			writeSettings: vi.fn(async (update: { cloudflareDeployment: null }) => { Object.assign(plugin.settings, update); }),
		};
		const rerender = vi.fn();
		openConfirmationModal.mockResolvedValue(confirmed);
		renderForgetServerSetting({ containerEl: new FakeElement('div') as never, plugin: plugin as never, rerender });
		getSettingByName('Forget saved connection').buttons[0]!.click();
		if (confirmed) {
			await vi.waitFor(() => expect(rerender).toHaveBeenCalledOnce());
			expect(plugin.settings.cloudflareDeployment).toBeNull();
			expect(plugin.syncRuntime.clearSyncConfiguration).toHaveBeenCalledOnce();
			expect(plugin.cloudflareDeploymentService.cancelPendingDeployment).toHaveBeenCalledOnce();
		} else {
			await flushMicrotasks();
			expect(plugin.settings.cloudflareDeployment).toBe(saved);
			expect(plugin.syncRuntime.clearSyncConfiguration).not.toHaveBeenCalled();
		}
		expect(startCloudflareDeployment).not.toHaveBeenCalled();
	});

	it('disconnects locally without offering device setup links', async () => {
		const { renderAccountSection } = await loadConfigSectionModule();
		const clearSyncConfiguration = vi.fn(async () => {});
		const rerender = vi.fn();
		openConfirmationModal.mockResolvedValue(true);
		const plugin = { secretStorage: { get: () => null }, manifest: { version: '0.2.0' },
			app: {},
			settings: { cloudflareDeployment: null },
			clearSettingsUiState: vi.fn(),
			syncRuntime: { getCachedVersionInfo: () => undefined, getVersionInfo: vi.fn(async () => ({ serverRevision: 7, deploymentFingerprint: embeddedArtifact.fingerprint })),
				isConfigured: vi.fn(() => true),
				clearSyncConfiguration,
			},
		};

		renderAccountSection({
			containerEl: new FakeElement('div') as never,
			plugin: plugin as never,
			rerender,
		});

		expect(MockSetting.instances.map(setting => setting.nameEl.textContent)).toEqual([
			'Server address', 'Pairing code or access token', 'Reconnect',
			'Connected to Crate',
		]);
		getSettingByName('Connected to Crate').buttons[0]?.click();
		await flushMicrotasks();
		expect(clearSyncConfiguration).toHaveBeenCalledTimes(1);
		expect(rerender).toHaveBeenCalledTimes(1);
	});

	it('automatically checks before updating when the saved revision is missing', async () => {
		const { renderServerUpdateNotice } = await loadConfigSectionModule();
		const getVersionInfo = vi.fn(async () => ({ serverRevision: 7, deploymentFingerprint: embeddedArtifact.fingerprint }));
		renderServerUpdateNotice({
			containerEl: new FakeElement('div') as never,
			plugin: { secretStorage: { get: () => null }, manifest: { version: '0.2.0' },
				settings: {
					cloudflareDeployment: {
						deploymentId: '0123456789abcdef',
						lastDeployedVersion: '0.1.0',
						lastDeployedFingerprint: 'a'.repeat(64),
					},
				},
				syncRuntime: { getCachedVersionInfo: () => undefined, getVersionInfo, isConfigured: vi.fn(() => true) },
			} as never,
			rerender: vi.fn(),
		});

		expect(getVersionInfo).toHaveBeenCalledOnce();
		const row = getSettingByName('Check server version');
		expect(row.buttons[0]!.buttonEl.style.display).toBe('none');
		expect(row.buttons[1]!.buttonEl.textContent).toBe('Checking…');
		expect(row.buttons[1]!.buttonEl.style.display).not.toBe('none');
		expect(startCloudflareDeployment).not.toHaveBeenCalled();
	});

	it('checks the connected server version only when requested', async () => {
		const { renderServerSection } = await loadConfigSectionModule();
		const getVersionInfo = vi.fn(async () => ({ serverRevision: 7, deploymentFingerprint: embeddedArtifact.fingerprint }));
		renderServerSection({
			containerEl: new FakeElement('div') as never,
			plugin: { secretStorage: { get: () => null }, manifest: { version: '0.2.0' },
				settings: {
					cloudflareDeployment: {
						deploymentId: '0123456789abcdef',
						lastDeployedVersion: embeddedArtifact.version,
						lastDeployedFingerprint: embeddedArtifact.fingerprint,
					},
				},
				syncRuntime: { getCachedVersionInfo: () => undefined, getVersionInfo, isConfigured: vi.fn(() => true) },
			} as never,
			rerender: vi.fn(),
		});

		const serverSetting = getSettingByName('Connected server');
		expect(getVersionInfo).not.toHaveBeenCalled();
		expect(serverSetting.descEl.textContent).toContain('Select the button');
		expect(serverSetting.buttons[0]?.buttonEl.textContent).toBe('Check version');
		serverSetting.buttons[0]?.click();
		await flushMicrotasks();
		expect(getVersionInfo).toHaveBeenCalledOnce();
		expect(serverSetting.descEl.textContent).toBe('Revision 7 · Matches the bundled server.');
		expect(serverSetting.buttons[0]?.buttonEl.classNames.has('is-disabled')).toBe(false);
	});
});

it.each([true, false])('hides the top notice when no update is actionable (connected: %s)', async connected => {
    const { renderServerUpdateNotice } = await loadConfigSectionModule();
    renderServerUpdateNotice({
        containerEl: new FakeElement('div') as never,
        plugin: { secretStorage: { get: () => null }, manifest: { version: '0.2.0' },
            settings: { cloudflareDeployment: {
                lastDeployedVersion: embeddedArtifact.version,
                lastDeployedFingerprint: embeddedArtifact.fingerprint,
            } },
            syncRuntime: { getCachedVersionInfo: () => undefined, getVersionInfo: vi.fn(async () => ({ serverRevision: 7, deploymentFingerprint: embeddedArtifact.fingerprint })), isConfigured: () => connected },
        } as never,
        rerender: vi.fn(),
    });
    expect(MockSetting.instances).toHaveLength(0);
});

it('keeps the installed version in the server section without duplicating the update button', async () => {
    const { renderServerSection } = await loadConfigSectionModule();
    renderServerSection({
        containerEl: new FakeElement('div') as never,
        plugin: { secretStorage: { get: () => null }, manifest: { version: '0.2.0' },
            settings: { cloudflareDeployment: {
                lastDeployedVersion: '0.0.9',
                lastDeployedFingerprint: 'old',
            } },
            syncRuntime: { getCachedVersionInfo: () => undefined, getVersionInfo: vi.fn(async () => ({ serverRevision: 7, deploymentFingerprint: embeddedArtifact.fingerprint })), isConfigured: () => true },
        } as never,
        rerender: vi.fn(),
    });
	await flushMicrotasks();
	const server = getSettingByName('Connected server');
	expect(server.buttons).toHaveLength(1);
	server.buttons[0]?.click();
	await flushMicrotasks();
	expect(server.descEl.textContent).toContain('Revision 7');
	expect(MockSetting.instances.some(setting => setting.nameEl.textContent === 'Cloudflare update available')).toBe(false);
});


it('lets an older server save its vault name through an explicit update', async () => {
	const { renderServerSection } = await loadConfigSectionModule();
	const plugin = { secretStorage: { get: () => null }, manifest: { version: '0.2.0' },
		settings: { workerUrl: 'https://crate.example', cloudflareDeployment: { accountId: 'account', d1DatabaseId: 'database' } },
		syncRuntime: { getCachedVersionInfo: () => undefined, getVersionInfo: vi.fn(async () => ({ serverRevision: 7, deploymentFingerprint: embeddedArtifact.fingerprint })), isConfigured: () => true },
	};
	renderServerSection({ containerEl: new FakeElement('div') as never, plugin: plugin as never, rerender: vi.fn() });
	const setting = getSettingByName('Vault name');
	expect(setting.buttons[0]?.buttonEl.textContent).toBe('Save vault name');
	setting.buttons[0]?.click();
	expect(startCloudflareDeployment).toHaveBeenCalledWith(plugin, 'update');
});


it.each([false, true])('disconnects with optional forgetting (%s)', async forget => {
	const { renderAccountSection } = await loadConfigSectionModule();
	const saved = { accountId: 'account', d1DatabaseId: 'database' };
	const plugin = { secretStorage: { get: () => null },
		app: {}, settings: { cloudflareDeployment: saved as typeof saved | null },
		cloudflareDeploymentService: { cancelPendingDeployment: vi.fn() },
		clearSettingsUiState: vi.fn(),
		syncRuntime: { getCachedVersionInfo: () => undefined, isConfigured: () => true, clearSyncConfiguration: vi.fn(async () => {}) },
		writeSettings: vi.fn(async (update: { cloudflareDeployment: null }) => { Object.assign(plugin.settings, update); }),
	};
	openConfirmationModal.mockImplementation(async (_app: unknown, options: ConfirmationModalOptions) => {
		expect(options.message).toBe('Sync will stop on this device.');
		expect(options.details).toEqual(['Your local files, server data, and Cloudflare login are kept. Other devices stay connected.']);
		expect(options.checkbox!.label).toBe('Forget saved connection');
		if (forget) options.checkbox!.onChange(true);
		return true;
	});
	const rerender = vi.fn();
	renderAccountSection({ containerEl: new FakeElement('div') as never, plugin: plugin as never, rerender });
	getSettingByName('account').buttons[0]!.click();
	await vi.waitFor(() => expect(rerender).toHaveBeenCalledOnce());
	expect(plugin.syncRuntime.clearSyncConfiguration).toHaveBeenCalledOnce();
	expect(plugin.settings.cloudflareDeployment).toBe(forget ? null : saved);
	expect(plugin.cloudflareDeploymentService.cancelPendingDeployment).toHaveBeenCalledTimes(forget ? 1 : 0);
});

it('does not forget or disconnect when the dialog is cancelled after choosing forget', async () => {
	const { renderAccountSection } = await loadConfigSectionModule();
	const plugin = { secretStorage: { get: () => null },
		app: {}, settings: { cloudflareDeployment: { accountId: 'account' } },
		clearSettingsUiState: vi.fn(), writeSettings: vi.fn(),
		syncRuntime: { getCachedVersionInfo: () => undefined, isConfigured: () => true, clearSyncConfiguration: vi.fn() },
	};
	openConfirmationModal.mockImplementation(async (_app: unknown, options: ConfirmationModalOptions) => {
		options.checkbox!.onChange(true);
		return false;
	});
	renderAccountSection({ containerEl: new FakeElement('div') as never, plugin: plugin as never, rerender: vi.fn() });
	getSettingByName('account').buttons[0]!.click();
	await flushMicrotasks();
	expect(plugin.syncRuntime.clearSyncConfiguration).not.toHaveBeenCalled();
	expect(plugin.writeSettings).not.toHaveBeenCalled();
});

it('keeps a matching live build visible and routes it to recovery when saved deployment metadata is stale', async () => {
    const { renderServerUpdateNotice } = await loadConfigSectionModule();
    const plugin = { secretStorage: { get: () => null },
        settings: { cloudflareDeployment: { lastDeployedVersion: embeddedArtifact.version, lastDeployedFingerprint: 'a'.repeat(64) } },
        syncRuntime: { getCachedVersionInfo: () => undefined, isConfigured: () => true, getVersionInfo: async () => ({ deploymentFingerprint: embeddedArtifact.fingerprint }) },
    };
    renderServerUpdateNotice({ containerEl: new FakeElement('div') as never, plugin: plugin as never, rerender: vi.fn() });
    await flushMicrotasks();
    const update = getSettingByName('Verify server update');
    expect(update.buttons[0]?.buttonEl.textContent).toBe('Check and recover update');
    expect(update.settingEl.style.display).not.toBe('none');
    update.buttons[0]?.click();
    expect(checkAndRecoverUpdate).toHaveBeenCalledWith(plugin, expect.any(Function));
    expect(startCloudflareDeployment).not.toHaveBeenCalled();
});


it('offers one Cloudflare reconnect action even while configured', async () => {
	const { renderAccountSection } = await loadConfigSectionModule();
	const plugin = {
		settings: { cloudflareDeployment: { accountId: 'account' } },
		syncRuntime: { getCachedVersionInfo: () => undefined, isConfigured: () => true },
	};
	renderAccountSection({ containerEl: new FakeElement('div') as never, plugin: plugin as never, rerender: vi.fn() });
	const reconnect = getSettingByName('Connection');
	reconnect.buttons[0]!.click();
	await flushMicrotasks();
	expect(startCloudflareDeployment).toHaveBeenCalledExactlyOnceWith(plugin, 'reconnect');
});

it.each([undefined, 'copying', 'complete'])('offers restore, resume or review from server settings (%s)', async phase => {
  const { renderServerSection } = await loadConfigSectionModule();
  const plugin = { app: {}, manifest: { version: '0.3.0' }, settings: { cloudflareDeployment: { accountId: 'account', d1DatabaseId: 'database' }, cloudflareRestore: phase ? { phase } : undefined }, syncRuntime: { getCachedVersionInfo: () => undefined, isConfigured: () => true, getVersionInfo: vi.fn() } };
  renderServerSection({ containerEl: new FakeElement('div') as never, plugin: plugin as never, rerender: vi.fn() });
  const button = getSettingByName('Server backup recovery').buttons[0]!;
  expect(button.buttonEl.textContent).toBe(phase === 'complete' ? 'View restored server' : phase ? 'Resume restore' : 'Restore backup…');
  button.click(); await vi.waitFor(() => expect(openServerRestore).toHaveBeenCalledWith(plugin));
});


it('allows an installed revision 1 server to update to the current bundle', async () => {
  const { renderServerUpdateNotice } = await loadConfigSectionModule();
  const plugin = {
    settings: {
      workerUrl: 'https://crate-0123456789abcdef.example.workers.dev',
      cloudflareDeployment: {
        workerName: 'crate-0123456789abcdef', workersSubdomain: 'example',
        lastKnownRevision: 1, lastDeployedVersion: embeddedArtifact.version,
        lastDeployedFingerprint: 'a'.repeat(64),
      },
    },
    syncRuntime: { getCachedVersionInfo: () => undefined, isConfigured: () => true, getVersionInfo: vi.fn() },
  };
  renderServerUpdateNotice({ containerEl: new FakeElement('div') as never, plugin: plugin as never, rerender: vi.fn() });
  const row = getSettingByName('Cloudflare update available');
  expect(row.descEl.textContent).toContain('Current version: 1');
  row.buttons[0]!.click();
  expect(startCloudflareDeployment).toHaveBeenCalledWith(plugin);
  expect(plugin.syncRuntime.getVersionInfo).not.toHaveBeenCalled();
});


it.each(['older development', 'stable', 'newer development', 'missing fingerprint', 'offline'])('checks automatically and preserves upgrade guards: %s', async live => {
  const worker = 'crate-0123456789abcdef';
  embeddedArtifact.development = { number: 3, worker };
  const { renderServerUpdateNotice } = await loadConfigSectionModule();
  const getVersionInfo = vi.fn(async () => {
    if (live === 'offline') throw new Error('Offline');
    return { serverRevision: release.revision, deploymentFingerprint: live === 'missing fingerprint' ? undefined : 'a'.repeat(64),
      developmentBuild: live === 'stable' ? undefined : { worker, number: live === 'newer development' ? 4 : 2 } };
  });
  const plugin = { settings: {
    workerUrl: `https://${worker}.example.workers.dev`,
    cloudflareDeployment: { workerName: worker, workersSubdomain: 'example', lastKnownRevision: release.revision,
      lastDeployedVersion: embeddedArtifact.version, lastDeployedFingerprint: 'a'.repeat(64) },
  }, syncRuntime: { getCachedVersionInfo: () => undefined, isConfigured: () => true, getVersionInfo } };
  renderServerUpdateNotice({ containerEl: new FakeElement('div') as never, plugin: plugin as never, rerender: vi.fn() });
  const row = getSettingByName('Check server version');
  const visibleButtons = () => row.buttons.filter(button => button.buttonEl.style.display !== 'none');
  expect(visibleButtons().map(button => button.buttonEl.textContent)).toEqual(['Checking…']);
  expect(getVersionInfo).toHaveBeenCalledOnce();
  const check = visibleButtons()[0]!;
  expect(check.buttonEl.textContent).toBe('Checking…');
  expect(check.buttonEl.classNames.has('is-disabled')).toBe(true);
  await vi.waitFor(() => expect(check.buttonEl.classNames.has('is-disabled')).toBe(false));
  expect(getVersionInfo).toHaveBeenCalledOnce();
  expect(startCloudflareDeployment).not.toHaveBeenCalled();
  if (live === 'older development') {
    expect(row.descEl.textContent).toContain(`${release.revision}-dev.2`);
    expect(visibleButtons().map(button => button.buttonEl.textContent)).toEqual(['Update server']);
    visibleButtons()[0]!.click();
    expect(startCloudflareDeployment).toHaveBeenCalledExactlyOnceWith(plugin);
  } else {
    expect(visibleButtons().map(button => button.buttonEl.textContent)).toEqual(['Check for updates']);
    expect(row.buttons[0]!.buttonEl.classNames.has('is-disabled')).toBe(true);
    expect(row.descEl.textContent).toContain(`${release.revision}-dev.3`);
    if (live === 'offline') {
      getVersionInfo.mockResolvedValueOnce({ serverRevision: release.revision, deploymentFingerprint: 'a'.repeat(64), developmentBuild: { worker, number: 2 } });
      visibleButtons()[0]!.click();
      await vi.waitFor(() => expect(visibleButtons().map(button => button.buttonEl.textContent)).toEqual(['Update server']));
      expect(getVersionInfo).toHaveBeenCalledTimes(2);
      expect(startCloudflareDeployment).not.toHaveBeenCalled();
    }
  }
});

it.each([undefined, release.revision - 1, release.revision, release.revision + 1])('explains a development target mismatch without offering an update or a pointless check (revision=%s)', async revision => {
  embeddedArtifact.development = { number: 28, worker: 'crate-fedcba9876543210' };
  const { renderServerUpdateNotice } = await loadConfigSectionModule();
  const plugin = { settings: {
    workerUrl: 'https://crate-0123456789abcdef.example.workers.dev',
    cloudflareDeployment: { workerName: 'crate-0123456789abcdef', workersSubdomain: 'example',
      lastKnownRevision: revision, lastDeployedVersion: embeddedArtifact.version, lastDeployedFingerprint: 'a'.repeat(64) },
  }, syncRuntime: { getCachedVersionInfo: () => undefined, isConfigured: () => true, getVersionInfo: vi.fn() } };
  renderServerUpdateNotice({ containerEl: new FakeElement('div') as never, plugin: plugin as never, rerender: vi.fn() });
  const row = getSettingByName('Server update unavailable');
  expect(row.descEl.textContent).toContain('This development build targets a different server');
  expect(row.buttons.filter(button => button.buttonEl.style.display !== 'none')).toHaveLength(0);
  row.buttons[0]!.click();
  expect(startCloudflareDeployment).not.toHaveBeenCalled();
  expect(plugin.syncRuntime.getVersionInfo).not.toHaveBeenCalled();
});
