import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	FakeElement,
	MockSetting,
	createObsidianUiModule,
	noticeMessages,
	resetObsidianUiMocks,
} from '../../test/fakes/obsidian-ui';

const openConfirmationModal = vi.fn();
const buildSetupLink = vi.fn();
const qrModalOpen = vi.fn();
const startCloudflareDeployment = vi.fn();

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function loadConfigSectionModule() {
	vi.doMock('obsidian', () => createObsidianUiModule());
	vi.doMock('../../cloudflare/plugin-integration', () => ({ startCloudflareDeployment }));
	vi.doMock('../confirmation-modal', () => ({ openConfirmationModal }));
	vi.doMock('../qr-modal', () => ({
		QRModal: class QRModal {
			constructor(public readonly app: unknown, public readonly link: string) {}
			open(): void { qrModalOpen(this.link); }
		},
	}));
	vi.doMock('./config-link', () => ({ buildSetupLink }));
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
	buildSetupLink.mockReset();
	qrModalOpen.mockReset();
	startCloudflareDeployment.mockReset();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
	vi.clearAllMocks();
	vi.doUnmock('obsidian');
	vi.doUnmock('../../cloudflare/plugin-integration');
	vi.doUnmock('../confirmation-modal');
	vi.doUnmock('../qr-modal');
	vi.doUnmock('./config-link');
	vi.doUnmock('./section-helpers');
});

describe('renderConfigSection integration', () => {
	it('opens Cloudflare deployment and an existing Worker setup page', async () => {
		const { renderConfigSection } = await loadConfigSectionModule();
		const open = vi.fn();
		vi.stubGlobal('window', { open });

		renderConfigSection({
			containerEl: new FakeElement('div') as never,
			plugin: {
				settings: { cloudflareDeployment: null },
				syncRuntime: { isConfigured: vi.fn(() => false) },
			} as never,
			rerender: vi.fn(),
		});

		expect(MockSetting.instances.map(setting => setting.nameEl.textContent)).toEqual([
			'Deploy sync server',
			'Open existing server',
		]);
		getSettingByName('Deploy sync server').buttons[0]?.click();
		expect(startCloudflareDeployment).toHaveBeenCalledTimes(1);

		const existingServer = getSettingByName('Open existing server');
		existingServer.buttons[0]?.click();
		expect(noticeMessages).toContain('Enter a valid HTTPS worker URL');
		existingServer.texts[0]?.change(' https://worker.example/ ');
		existingServer.buttons[0]?.click();
		expect(open).toHaveBeenLastCalledWith('https://worker.example/', '_blank', 'noopener,noreferrer');
	});

	it('wires one-time device setup and local reset actions when configured', async () => {
		const { renderConfigSection } = await loadConfigSectionModule();
		const clearSyncConfiguration = vi.fn(async () => {});
		const rerender = vi.fn();
		const clipboardWriteText = vi.fn(async () => {});
		vi.stubGlobal('navigator', { clipboard: { writeText: clipboardWriteText } });
		buildSetupLink.mockResolvedValue('obsidian://crate-setup?workerUrl=https://worker.example');
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

		renderConfigSection({
			containerEl: new FakeElement('div') as never,
			plugin: plugin as never,
			rerender,
		});

		expect(MockSetting.instances.map(setting => setting.nameEl.textContent)).toEqual([
			'Set up another device',
			'Reset local configuration',
		]);
		getSettingByName('Set up another device').buttons[0]?.click();
		await flushMicrotasks();
		expect(clipboardWriteText).toHaveBeenCalledTimes(1);
		getSettingByName('Set up another device').buttons[1]?.click();
		await flushMicrotasks();
		expect(qrModalOpen).toHaveBeenCalledTimes(1);
		getSettingByName('Reset local configuration').buttons[0]?.click();
		await flushMicrotasks();
		expect(clearSyncConfiguration).toHaveBeenCalledTimes(1);
		expect(rerender).toHaveBeenCalledTimes(1);
	});

	it('offers an in-place server update when OAuth deployment metadata exists', async () => {
		const { renderConfigSection } = await loadConfigSectionModule();
		renderConfigSection({
			containerEl: new FakeElement('div') as never,
			plugin: {
				settings: { cloudflareDeployment: { deploymentId: '0123456789abcdef' } },
				syncRuntime: { isConfigured: vi.fn(() => true) },
			} as never,
			rerender: vi.fn(),
		});

		getSettingByName('Update Cloudflare server').buttons[0]?.click();
		expect(startCloudflareDeployment).toHaveBeenCalledTimes(1);
	});
});
