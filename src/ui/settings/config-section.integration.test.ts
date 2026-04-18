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
const createInfrastructureFromCredentials = vi.fn();
const renderApiTokenSetup = vi.fn();
const resolveCredentialsForSetup = vi.fn();
const seedWizardState = vi.fn();
const runButtonTask = vi.fn();
const qrModalOpen = vi.fn();

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function loadConfigSectionModule() {
	vi.doMock('obsidian', () => createObsidianUiModule());
	vi.doMock('../confirmation-modal', () => ({
		openConfirmationModal,
	}));
	vi.doMock('../qr-modal', () => ({
		QRModal: class QRModal {
			constructor(public readonly app: unknown, public readonly link: string) {}

			open(): void {
				qrModalOpen(this.link);
			}
		},
	}));
	vi.doMock('./action-helpers', () => ({
		getErrorMessage: vi.fn((error: unknown) => String(error)),
		runButtonTask,
	}));
	vi.doMock('./config-link', () => ({
		buildSetupLink,
	}));
	vi.doMock('./config-setup-workflows', () => ({
		createInfrastructureFromCredentials,
		renderApiTokenSetup,
		resolveCredentialsForSetup,
		seedWizardState,
	}));
	vi.doMock('./section-helpers', () => ({
		createSettingsSectionHeading: vi.fn(),
	}));

	return import('./config-section');
}

function getSettingByName(name: string): MockSetting {
	const setting = MockSetting.instances.find((instance) => instance.nameEl.textContent === name);
	if (!setting) {
		throw new Error(`Setting not found: ${name}`);
	}
	return setting;
}

beforeEach(() => {
	resetObsidianUiMocks();
	openConfirmationModal.mockReset();
	buildSetupLink.mockReset();
	createInfrastructureFromCredentials.mockReset();
	renderApiTokenSetup.mockReset();
	resolveCredentialsForSetup.mockReset();
	seedWizardState.mockReset();
	runButtonTask.mockReset();
	qrModalOpen.mockReset();
	runButtonTask.mockImplementation(async (options: {
		task?: (helpers: { setProgress: (message: string) => void; setButtonText: (text: string) => void }) => Promise<unknown>;
		onSuccess?: (result: unknown) => void;
	}) => {
		const result = await options.task?.({
			setProgress: vi.fn(),
			setButtonText: vi.fn(),
		});
		options.onSuccess?.(result);
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
	vi.clearAllMocks();
	vi.doUnmock('obsidian');
	vi.doUnmock('../confirmation-modal');
	vi.doUnmock('../qr-modal');
	vi.doUnmock('./action-helpers');
	vi.doUnmock('./config-link');
	vi.doUnmock('./config-setup-workflows');
	vi.doUnmock('./section-helpers');
});

describe('renderConfigSection integration', () => {
	it('renders connected-account setup actions and runs quick setup through the configured workflow', async () => {
		const { renderConfigSection } = await loadConfigSectionModule();
		const rerender = vi.fn();
		const containerEl = new FakeElement('div');
		const wizardState = {
			wizardToken: '',
			wizardTokenValidated: false,
			wizardSelectedAccountId: '',
		};
		const plugin = {
			settings: {
				cloudflareAccountId: 'acct-123',
			},
			app: {},
			cloudflareSession: {
				hasCredentials: vi.fn(() => true),
			},
			syncRuntime: {
				isConfigured: vi.fn(() => false),
				clearSyncConfiguration: vi.fn(),
			},
		};

		resolveCredentialsForSetup.mockResolvedValue({
			accountId: 'acct-123',
			apiToken: 'cloudflare-token',
		});
		createInfrastructureFromCredentials.mockResolvedValue(undefined);

		renderConfigSection({
			containerEl: containerEl as never,
			plugin: plugin as never,
			wizardState,
			rerender,
		});

		expect(seedWizardState).toHaveBeenCalledWith(plugin, wizardState);
		expect(renderApiTokenSetup).not.toHaveBeenCalled();
		expect(MockSetting.instances.map((setting) => setting.nameEl.textContent)).toEqual([
			'Connected account',
			'Quick setup',
			'Reset local configuration',
		]);

		getSettingByName('Quick setup').buttons[0]?.click();
		await flushMicrotasks();

		expect(resolveCredentialsForSetup).toHaveBeenCalledWith(plugin, wizardState);
		expect(createInfrastructureFromCredentials).toHaveBeenCalledWith(
			plugin,
			{
				accountId: 'acct-123',
				apiToken: 'cloudflare-token',
			},
			expect.any(Function),
		);
		expect(rerender).toHaveBeenCalledTimes(1);
		expect(noticeMessages).toContain('Infrastructure created and plugin configured');
	});

	it('wires logout, copy link, show code, and reset confirmation actions when configured', async () => {
		const { renderConfigSection } = await loadConfigSectionModule();
		const clearSyncConfiguration = vi.fn(async () => {});
		const rerender = vi.fn();
		const clipboardWriteText = vi.fn(async () => {});
		const containerEl = new FakeElement('div');
		const plugin = {
			settings: {
				cloudflareAccountId: 'acct-123',
			},
			app: {},
			cloudflareSession: {
				hasCredentials: vi.fn(() => true),
			},
			syncRuntime: {
				isConfigured: vi.fn(() => true),
				clearSyncConfiguration,
			},
		};

		vi.stubGlobal('navigator', {
			clipboard: {
				writeText: clipboardWriteText,
			},
		});
		buildSetupLink.mockResolvedValue('obsidian://crate-setup?workerUrl=https://worker.example');
		openConfirmationModal.mockResolvedValue(true);

		renderConfigSection({
			containerEl: containerEl as never,
			plugin: plugin as never,
			wizardState: {
				wizardToken: '',
				wizardTokenValidated: false,
				wizardSelectedAccountId: '',
			},
			rerender,
		});

		expect(MockSetting.instances.map((setting) => setting.nameEl.textContent)).toEqual([
			'Connected account',
			'Set up another device',
			'Reset local configuration',
		]);

		getSettingByName('Connected account').buttons[0]?.click();
		await flushMicrotasks();
		expect(clearSyncConfiguration).toHaveBeenCalledWith({ clearCloudflareCredentials: true });

		getSettingByName('Set up another device').buttons[0]?.click();
		await flushMicrotasks();
		expect(buildSetupLink).toHaveBeenCalledWith(plugin);
		expect(clipboardWriteText).toHaveBeenCalledWith('obsidian://crate-setup?workerUrl=https://worker.example');

		getSettingByName('Set up another device').buttons[1]?.click();
		await flushMicrotasks();
		expect(qrModalOpen).toHaveBeenCalledWith('obsidian://crate-setup?workerUrl=https://worker.example');

		getSettingByName('Reset local configuration').buttons[0]?.click();
		await flushMicrotasks();
		expect(openConfirmationModal).toHaveBeenCalledTimes(1);
		expect(clearSyncConfiguration).toHaveBeenLastCalledWith();
		expect(rerender).toHaveBeenCalledTimes(2);
		expect(noticeMessages).toContain('Signed out and configuration cleared');
		expect(noticeMessages).toContain('Setup link copied to clipboard');
		expect(noticeMessages).toContain('Local plugin configuration cleared');
	});
});
