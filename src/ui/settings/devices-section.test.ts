import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	FakeElement,
	MockSetting,
	createObsidianUiModule,
	noticeMessages,
	resetObsidianUiMocks,
} from '../../test/fakes/obsidian-ui';

const openConfirmationModal = vi.fn();

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 12; i++) await Promise.resolve();
}

async function loadDevicesSectionModule() {
	vi.doMock('obsidian', () => createObsidianUiModule());
	vi.doMock('../confirmation-modal', () => ({
		openConfirmationModal,
	}));
	vi.doMock('./section-helpers', () => ({
		createSettingsSectionHeading: vi.fn(),
	}));

	return import('./devices-section');
}

function getSettingByName(name: string): MockSetting {
	const setting = MockSetting.instances.find((instance) => instance.nameEl.textContent === name);
	if (!setting) {
		throw new Error(`Setting not found: ${name}`);
	}
	return setting;
}

describe('renderDevicesSection', () => {
	beforeEach(() => {
		resetObsidianUiMocks();
		openConfirmationModal.mockReset();
	});

	afterEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		vi.doUnmock('obsidian');
		vi.doUnmock('../confirmation-modal');
		vi.doUnmock('./section-helpers');
	});

	it('renders connected devices, disables the current device action, and removes stale devices', async () => {
		const { renderDevicesSection } = await loadDevicesSectionModule();
		const listTokens = vi.fn(async () => ({
			tokens: [
				{
					id: 'other-id',
					device_id: 'device-other',
					device_name: 'Android device (5678)',
					platform: 'android',
					created_at: '2026-04-18 09:00:00',
					last_seen_at: '2026-04-18 12:00:00',
					is_current: false,
				},
				{
					id: 'current-id',
					device_id: 'device-current',
					device_name: 'Mac (1234)',
					platform: 'macos',
					created_at: '2026-04-18 10:00:00',
					last_seen_at: '2026-04-18 11:00:00',
					is_current: true,
				},
			],
		}));
		const revokeToken = vi.fn(async () => ({ success: true }));
		openConfirmationModal.mockResolvedValue(true);

		renderDevicesSection({
			containerEl: new FakeElement('div') as never,
			plugin: {
				app: {},
				settingsUiState: { devices: null },
				syncRuntime: {
					getApiClient: () => ({
						listTokens,
						revokeToken,
					}),
				},
			} as never,
		});
		await flushMicrotasks();

		expect(getSettingByName('Connected devices')).toBeTruthy();
		expect(MockSetting.instances.map((setting) => setting.nameEl.textContent)).toEqual([
			'Connected devices',
			'Mac (1234) (Current device)',
			'Android device (5678)',
		]);
		expect(getSettingByName('Mac (1234) (Current device)').buttons).toHaveLength(0);
		expect(getSettingByName('Android device (5678)').descEl.textContent).toContain('Last seen');

		getSettingByName('Android device (5678)').buttons[0]?.click();
		await flushMicrotasks();

		expect(openConfirmationModal).toHaveBeenCalledTimes(1);
		expect(revokeToken).toHaveBeenCalledWith('other-id');
		expect(listTokens).toHaveBeenCalledTimes(2);
		expect(noticeMessages).toContain('Removed Android device (5678)');
	});

	it('renders a failure message when device loading fails', async () => {
		const { renderDevicesSection } = await loadDevicesSectionModule();
		const containerEl = new FakeElement('div');

		renderDevicesSection({
			containerEl: containerEl as never,
			plugin: {
				app: {},
				settingsUiState: { devices: null },
				syncRuntime: {
					getApiClient: () => ({
						listTokens: vi.fn(async () => {
							throw new Error('boom');
						}),
						revokeToken: vi.fn(),
					}),
				},
			} as never,
		});
		await flushMicrotasks();

		expect(containerEl.collectText()).toContain('Failed to load connected devices.');
	});
});

describe('device list caching', () => {
	beforeEach(() => { resetObsidianUiMocks(); });
	afterEach(() => {
		vi.resetModules();
		vi.doUnmock('obsidian');
		vi.doUnmock('../confirmation-modal');
		vi.doUnmock('./section-helpers');
	});

	const device = {
		id: 'mac', device_id: 'device-mac', device_name: 'My Mac', platform: 'macos',
		created_at: '2026-09-05 10:00:00', last_seen_at: null, is_current: true,
	};

	it('shows loading initially, then cached devices immediately while refreshing', async () => {
		const { renderDevicesSection } = await loadDevicesSectionModule();
		const listTokens = vi.fn<() => Promise<{ tokens: typeof device[] }>>();
		let resolve!: (value: { tokens: typeof device[] }) => void;
		listTokens.mockReturnValueOnce(new Promise(done => { resolve = done; }));
		const client = { listTokens };
		const plugin = { settingsUiState: { devices: null }, syncRuntime: { getApiClient: () => client } };
		const first = new FakeElement('div');
		const cleanup = renderDevicesSection({ containerEl: first as never, plugin: plugin as never });
		expect(first.collectText()).toContain('Loading devices…');
		resolve({ tokens: [device] });
		await flushMicrotasks();
		expect(first.collectText()).toContain('My Mac');
		cleanup();

		listTokens.mockReturnValueOnce(new Promise(() => {}));
		const second = new FakeElement('div');
		renderDevicesSection({ containerEl: second as never, plugin: plugin as never });
		expect(second.collectText()).toContain('My Mac');
		expect(second.collectText()).toContain('Refreshing devices…');
		expect(listTokens).toHaveBeenCalledTimes(2);

		const third = new FakeElement('div');
		renderDevicesSection({ containerEl: third as never, plugin: plugin as never });
		expect(third.collectText()).toContain('My Mac');
		expect(listTokens).toHaveBeenCalledTimes(2);
	});

	it('retains the list when refreshing fails', async () => {
		const { renderDevicesSection } = await loadDevicesSectionModule();
		const listTokens = vi.fn().mockResolvedValueOnce({ tokens: [device] }).mockRejectedValueOnce(new Error('offline'));
		const client = { listTokens };
		const plugin = { settingsUiState: { devices: null }, syncRuntime: { getApiClient: () => client } };
		const container = new FakeElement('div');
		renderDevicesSection({ containerEl: container as never, plugin: plugin as never });
		await flushMicrotasks();
		getSettingByName('Connected devices').buttons[0]?.click();
		expect(container.collectText()).toContain('My Mac');
		await flushMicrotasks();
		expect(container.collectText()).toContain('My Mac');
		expect(container.collectText()).toContain('Showing the last loaded list.');
	});

	it('does not show cached devices from a previous connection', async () => {
		const { renderDevicesSection } = await loadDevicesSectionModule();
		const client = { listTokens: vi.fn(() => new Promise(() => {})) };
		const plugin = {
			settingsUiState: { devices: { client: {}, tokens: [device], pending: null } },
			syncRuntime: { getApiClient: () => client },
		};
		const container = new FakeElement('div');
		renderDevicesSection({ containerEl: container as never, plugin: plugin as never });
		expect(container.collectText()).not.toContain('My Mac');
		expect(container.collectText()).toContain('Loading devices…');
	});
});
