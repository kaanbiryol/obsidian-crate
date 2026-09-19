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
const embeddedArtifact = {
	version: '0.1.0',
	fingerprint: 'f'.repeat(64),
};

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function loadConfigSectionModule() {
	vi.doMock('obsidian', () => createObsidianUiModule());
	vi.doMock('../../cloudflare/deployment-recovery-ui', () => ({ checkAndRecoverUpdate }));
	vi.doMock('../../cloudflare/plugin-integration', () => ({ startCloudflareDeployment }));
	vi.doMock('../../cloudflare/embedded-artifacts', () => ({
		EMBEDDED_CLOUDFLARE_ARTIFACT: embeddedArtifact,
	}));
	vi.doMock('../confirmation-modal', () => ({ openConfirmationModal }));
	vi.doMock('./section-helpers', () => ({ createSettingsSectionHeading: vi.fn(), createSettingsDisclosure: (container: FakeElement) => container.createDiv() }));

	return import('./config-section');
}

function getSettingByName(name: string): MockSetting {
	const setting = MockSetting.instances.find(instance => instance.nameEl.textContent === name);
	if (!setting) throw new Error(`Setting not found: ${name}`);
	return setting;
}

beforeEach(() => {
	resetObsidianUiMocks();
	openConfirmationModal.mockReset();
	startCloudflareDeployment.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
	vi.clearAllMocks();
	vi.doUnmock('obsidian');
	vi.doUnmock('../../cloudflare/plugin-integration');
	vi.doUnmock('../../cloudflare/deployment-recovery-ui');
	vi.doUnmock('../../cloudflare/embedded-artifacts');
	vi.doUnmock('../confirmation-modal');
	vi.doUnmock('./section-helpers');
});

describe('renderConfigSection integration', () => {
	it('uses Cloudflare as the only unconfigured-device connection path', async () => {
		const { renderConfigSection } = await loadConfigSectionModule();

		renderConfigSection({
			containerEl: new FakeElement('div') as never,
			plugin: { manifest: { version: '0.2.0' },
				settings: { cloudflareDeployment: null },
				syncRuntime: { getVersionInfo: vi.fn(async () => ({ serverRevision: 7, deploymentFingerprint: embeddedArtifact.fingerprint })), isConfigured: vi.fn(() => false) },
			} as never,
			rerender: vi.fn(),
		});

		expect(MockSetting.instances.map(setting => setting.nameEl.textContent)).toEqual([
			'Connect with Cloudflare',
		]);
		expect(getSettingByName('Connect with Cloudflare').descEl.textContent).toBe(
			'Sign in to connect to an existing Crate server or create one in your Cloudflare account. Cloudflare plan limits and usage charges may apply.',
		);
		getSettingByName('Connect with Cloudflare').buttons[0]?.click();
		expect(startCloudflareDeployment).toHaveBeenCalledTimes(1);
	});

	it('offers reconnect for a remembered server on a disconnected device', async () => {
		const { renderConfigSection } = await loadConfigSectionModule();
		const plugin = { manifest: { version: '0.2.0' },
			settings: { cloudflareDeployment: { accountId: 'account', d1DatabaseId: 'database' } },
			syncRuntime: { getVersionInfo: vi.fn(async () => ({ serverRevision: 7, deploymentFingerprint: embeddedArtifact.fingerprint })), isConfigured: () => false },
		};
		renderConfigSection({ containerEl: new FakeElement('div') as never, plugin: plugin as never, rerender: vi.fn() });
		expect(MockSetting.instances.map(setting => setting.nameEl.textContent)).toEqual(['Reconnect']);
		const reconnect = getSettingByName('Reconnect');
		expect(reconnect.descEl.textContent).toContain('using your saved Cloudflare login');
		reconnect.buttons[0]!.click();
		expect(startCloudflareDeployment).toHaveBeenCalledExactlyOnceWith(plugin);
	});

	it.each([true, false])('forgets a server only after confirmation (%s)', async confirmed => {
		await loadConfigSectionModule();
		const { renderForgetServerSetting } = await import('./server-selection-setting');
		const saved = { accountId: 'account', d1DatabaseId: 'database' };
		const plugin = { manifest: { version: '0.2.0' },
			app: {}, settings: { cloudflareDeployment: saved as typeof saved | null },
			cloudflareDeploymentService: { cancelPendingDeployment: vi.fn() },
			clearSettingsUiState: vi.fn(),
			syncRuntime: { getVersionInfo: vi.fn(async () => ({ serverRevision: 7, deploymentFingerprint: embeddedArtifact.fingerprint })), isConfigured: () => false, clearSyncConfiguration: vi.fn(async () => {}) },
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
		const plugin = { manifest: { version: '0.2.0' },
			app: {},
			settings: { cloudflareDeployment: null },
			clearSettingsUiState: vi.fn(),
			syncRuntime: { getVersionInfo: vi.fn(async () => ({ serverRevision: 7, deploymentFingerprint: embeddedArtifact.fingerprint })),
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
			'Connected to Crate',
		]);
		getSettingByName('Connected to Crate').buttons[0]?.click();
		await flushMicrotasks();
		expect(clearSyncConfiguration).toHaveBeenCalledTimes(1);
		expect(rerender).toHaveBeenCalledTimes(1);
	});

	it('offers an in-place server update in the top notice when deployment metadata exists', async () => {
		const { renderServerUpdateNotice } = await loadConfigSectionModule();
		renderServerUpdateNotice({
			containerEl: new FakeElement('div') as never,
			plugin: { manifest: { version: '0.2.0' },
				settings: {
					cloudflareDeployment: {
						deploymentId: '0123456789abcdef',
						lastDeployedVersion: '0.1.0',
						lastDeployedFingerprint: 'a'.repeat(64),
					},
				},
				syncRuntime: { getVersionInfo: vi.fn(async () => ({ serverRevision: 7, deploymentFingerprint: embeddedArtifact.fingerprint })), isConfigured: vi.fn(() => true) },
			} as never,
			rerender: vi.fn(),
		});

		getSettingByName('Cloudflare update available').buttons[0]?.click();
		expect(startCloudflareDeployment).toHaveBeenCalledTimes(1);
	});

	it('shows an up-to-date status without an authorization action', async () => {
		const { renderServerSection } = await loadConfigSectionModule();
		renderServerSection({
			containerEl: new FakeElement('div') as never,
			plugin: { manifest: { version: '0.2.0' },
				settings: {
					cloudflareDeployment: {
						deploymentId: '0123456789abcdef',
						lastDeployedVersion: embeddedArtifact.version,
						lastDeployedFingerprint: embeddedArtifact.fingerprint,
					},
				},
				syncRuntime: { getVersionInfo: vi.fn(async () => ({ serverRevision: 7, deploymentFingerprint: embeddedArtifact.fingerprint })), isConfigured: vi.fn(() => true) },
			} as never,
			rerender: vi.fn(),
		});

		await flushMicrotasks();
		const serverSetting = getSettingByName('Connected server');
		expect(serverSetting.descEl.textContent).toBe('Revision 7 · Matches the bundled server.');
		expect(serverSetting.buttons).toHaveLength(0);
	});
});

it.each([true, false])('hides the top notice when no update is actionable (connected: %s)', async connected => {
    const { renderServerUpdateNotice } = await loadConfigSectionModule();
    renderServerUpdateNotice({
        containerEl: new FakeElement('div') as never,
        plugin: { manifest: { version: '0.2.0' },
            settings: { cloudflareDeployment: {
                lastDeployedVersion: embeddedArtifact.version,
                lastDeployedFingerprint: embeddedArtifact.fingerprint,
            } },
            syncRuntime: { getVersionInfo: vi.fn(async () => ({ serverRevision: 7, deploymentFingerprint: embeddedArtifact.fingerprint })), isConfigured: () => connected },
        } as never,
        rerender: vi.fn(),
    });
    expect(MockSetting.instances).toHaveLength(0);
});

it('keeps the installed version in the server section without duplicating the update button', async () => {
    const { renderServerSection } = await loadConfigSectionModule();
    renderServerSection({
        containerEl: new FakeElement('div') as never,
        plugin: { manifest: { version: '0.2.0' },
            settings: { cloudflareDeployment: {
                lastDeployedVersion: '0.0.9',
                lastDeployedFingerprint: 'old',
            } },
            syncRuntime: { getVersionInfo: vi.fn(async () => ({ serverRevision: 7, deploymentFingerprint: embeddedArtifact.fingerprint })), isConfigured: () => true },
        } as never,
        rerender: vi.fn(),
    });
    await flushMicrotasks();
    const server = getSettingByName('Connected server');
    expect(server.descEl.textContent).toContain('Revision 7');
    expect(server.buttons).toHaveLength(0);
    expect(MockSetting.instances.some(setting => setting.nameEl.textContent === 'Cloudflare update available')).toBe(false);
});


it('lets an older server save its vault name through an explicit update', async () => {
	const { renderServerSection } = await loadConfigSectionModule();
	const plugin = { manifest: { version: '0.2.0' },
		settings: { workerUrl: 'https://crate.example', cloudflareDeployment: { accountId: 'account', d1DatabaseId: 'database' } },
		syncRuntime: { getVersionInfo: vi.fn(async () => ({ serverRevision: 7, deploymentFingerprint: embeddedArtifact.fingerprint })), isConfigured: () => true },
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
	const plugin = {
		app: {}, settings: { cloudflareDeployment: saved as typeof saved | null },
		cloudflareDeploymentService: { cancelPendingDeployment: vi.fn() },
		clearSettingsUiState: vi.fn(),
		syncRuntime: { isConfigured: () => true, clearSyncConfiguration: vi.fn(async () => {}) },
		writeSettings: vi.fn(async (update: { cloudflareDeployment: null }) => { Object.assign(plugin.settings, update); }),
	};
	openConfirmationModal.mockImplementation(async (_app: unknown, options: ConfirmationModalOptions) => {
		expect(options.checkbox!.label).toBe('Also forget the saved server connection');
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
	const plugin = {
		app: {}, settings: { cloudflareDeployment: { accountId: 'account' } },
		clearSettingsUiState: vi.fn(), writeSettings: vi.fn(),
		syncRuntime: { isConfigured: () => true, clearSyncConfiguration: vi.fn() },
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
    const plugin = {
        settings: { cloudflareDeployment: { lastDeployedVersion: embeddedArtifact.version, lastDeployedFingerprint: 'a'.repeat(64) } },
        syncRuntime: { isConfigured: () => true, getVersionInfo: async () => ({ deploymentFingerprint: embeddedArtifact.fingerprint }) },
    };
    renderServerUpdateNotice({ containerEl: new FakeElement('div') as never, plugin: plugin as never, rerender: vi.fn() });
    await flushMicrotasks();
    const update = getSettingByName('Verify server update');
    expect(update.buttons[0]?.buttonEl.textContent).toBe('Check and recover update');
    expect(update.settingEl.style.display).not.toBe('none');
    update.buttons[0]?.click();
    expect(checkAndRecoverUpdate).toHaveBeenCalledWith(plugin);
    expect(startCloudflareDeployment).not.toHaveBeenCalled();
});
