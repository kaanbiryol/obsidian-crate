import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	FakeElement,
	MockSetting,
	createObsidianUiModule,
	resetObsidianUiMocks,
} from '../../test/fakes/obsidian-ui';

const openConfirmationModal = vi.fn();
const startCloudflareDeployment = vi.fn();
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
	vi.doMock('../../cloudflare/plugin-integration', () => ({ startCloudflareDeployment }));
	vi.doMock('../../cloudflare/embedded-artifacts', () => ({
		EMBEDDED_CLOUDFLARE_ARTIFACT: embeddedArtifact,
	}));
	vi.doMock('../confirmation-modal', () => ({ openConfirmationModal }));
	vi.doMock('./section-helpers', () => ({ createSettingsSectionHeading: vi.fn() }));

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
	vi.doUnmock('../../cloudflare/embedded-artifacts');
	vi.doUnmock('../confirmation-modal');
	vi.doUnmock('./section-helpers');
});

describe('renderConfigSection integration', () => {
	it('uses Cloudflare as the only unconfigured-device connection path', async () => {
		const { renderConfigSection } = await loadConfigSectionModule();

		renderConfigSection({
			containerEl: new FakeElement('div') as never,
			plugin: {
				settings: { cloudflareDeployment: null },
				syncRuntime: { isConfigured: vi.fn(() => false) },
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

	it('disconnects locally without offering device setup links', async () => {
		const { renderDisconnectSetting } = await loadConfigSectionModule();
		const clearSyncConfiguration = vi.fn(async () => {});
		const rerender = vi.fn();
		openConfirmationModal.mockResolvedValue(true);
		const plugin = {
			app: {},
			settings: { cloudflareDeployment: null },
			clearSettingsUiState: vi.fn(),
			syncRuntime: {
				isConfigured: vi.fn(() => true),
				clearSyncConfiguration,
			},
		};

		renderDisconnectSetting({
			containerEl: new FakeElement('div') as never,
			plugin: plugin as never,
			rerender,
		});

		expect(MockSetting.instances.map(setting => setting.nameEl.textContent)).toEqual([
			'Disconnect this device',
		]);
		getSettingByName('Disconnect this device').buttons[0]?.click();
		await flushMicrotasks();
		expect(clearSyncConfiguration).toHaveBeenCalledTimes(1);
		expect(rerender).toHaveBeenCalledTimes(1);
	});

	it('offers an in-place server update when OAuth deployment metadata exists', async () => {
		const { renderConfigSection } = await loadConfigSectionModule();
		renderConfigSection({
			containerEl: new FakeElement('div') as never,
			plugin: {
				settings: {
					cloudflareDeployment: {
						deploymentId: '0123456789abcdef',
						lastDeployedVersion: '0.1.0',
						lastDeployedFingerprint: 'a'.repeat(64),
					},
				},
				syncRuntime: { isConfigured: vi.fn(() => true) },
			} as never,
			rerender: vi.fn(),
		});

		getSettingByName('Cloudflare update available').buttons[0]?.click();
		expect(startCloudflareDeployment).toHaveBeenCalledTimes(1);
	});

	it('shows an up-to-date status without an authorization action', async () => {
		const { renderConfigSection } = await loadConfigSectionModule();
		renderConfigSection({
			containerEl: new FakeElement('div') as never,
			plugin: {
				settings: {
					cloudflareDeployment: {
						deploymentId: '0123456789abcdef',
						lastDeployedVersion: embeddedArtifact.version,
						lastDeployedFingerprint: embeddedArtifact.fingerprint,
					},
				},
				syncRuntime: { isConfigured: vi.fn(() => true) },
			} as never,
			rerender: vi.fn(),
		});

		const serverSetting = getSettingByName('Cloudflare server');
		expect(serverSetting.descEl.textContent).toBe('Your sync server and reminders web app are up to date.');
		expect(serverSetting.buttons).toHaveLength(0);
	});
});
