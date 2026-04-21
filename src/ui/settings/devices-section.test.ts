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
	await Promise.resolve();
	await Promise.resolve();
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
					id: 'current-id',
					device_id: 'device-current',
					device_name: 'Mac (1234)',
					platform: 'macos',
					created_at: '2026-04-18 10:00:00',
					last_seen_at: '2026-04-18 12:00:00',
					is_current: true,
				},
				{
					id: 'other-id',
					device_id: 'device-other',
					device_name: 'Android device (5678)',
					platform: 'android',
					created_at: '2026-04-18 09:00:00',
					last_seen_at: '2026-04-18 11:00:00',
					is_current: false,
				},
			],
		}));
		const revokeToken = vi.fn(async () => ({ success: true }));
		openConfirmationModal.mockResolvedValue(true);

		renderDevicesSection({
			containerEl: new FakeElement('div') as never,
			plugin: {
				app: {},
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
		expect(getSettingByName('Mac (1234) (Current device)').buttons).toHaveLength(0);
		expect(getSettingByName('Android device (5678)').descEl.textContent).toContain('Last seen');

		getSettingByName('Android device (5678)').buttons[0]?.click();
		await flushMicrotasks();

		expect(openConfirmationModal).toHaveBeenCalledTimes(1);
		expect(revokeToken).toHaveBeenCalledWith('other-id');
		expect(listTokens).toHaveBeenCalledTimes(2);
		expect(noticeMessages).toContain('Removed Android device (5678)');
	});

	it('hides unused setup-link placeholders from the devices list', async () => {
		const { renderDevicesSection } = await loadDevicesSectionModule();

		renderDevicesSection({
			containerEl: new FakeElement('div') as never,
			plugin: {
				app: {},
				syncRuntime: {
					getApiClient: () => ({
						listTokens: vi.fn(async () => ({
							tokens: [
								{
									id: 'placeholder-id',
									device_id: null,
									device_name: 'setup-link',
									platform: null,
									created_at: '2026-04-18 09:00:00',
									last_seen_at: null,
									is_current: false,
								},
							],
						})),
						revokeToken: vi.fn(),
					}),
				},
			} as never,
		});
		await flushMicrotasks();

		expect(() => getSettingByName('setup-link')).toThrow('Setting not found: setup-link');
		expect(MockSetting.instances.map((setting) => setting.nameEl.textContent)).toEqual(['Connected devices']);
	});

	it('renders a failure message when device loading fails', async () => {
		const { renderDevicesSection } = await loadDevicesSectionModule();
		const containerEl = new FakeElement('div');

		renderDevicesSection({
			containerEl: containerEl as never,
			plugin: {
				app: {},
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
