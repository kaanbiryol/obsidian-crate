import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	FakeElement,
	MockSetting,
	createObsidianUiModule,
	noticeMessages,
	resetObsidianUiMocks,
} from '../../test/fakes/obsidian-ui';

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function loadNotificationsSectionModule() {
	vi.doMock('obsidian', () => createObsidianUiModule());
	vi.doMock('../../reminders/plugin-integration', () => ({
		reconcileReminderNotifications: vi.fn(),
	}));
	vi.doMock('../qr-modal', () => ({
		QRModal: class QRModal {
			constructor(..._args: unknown[]) {}
			open(): void {}
		},
	}));

	return import('./notifications-section');
}

function getSettingByName(name: string): MockSetting {
	const setting = MockSetting.instances.find((instance) => instance.nameEl.textContent === name);
	if (!setting) {
		throw new Error(`Setting not found: ${name}`);
	}
	return setting;
}

describe('renderNotificationsSection', () => {
	beforeEach(() => {
		resetObsidianUiMocks();
	});

	afterEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		vi.doUnmock('obsidian');
		vi.doUnmock('../../reminders/plugin-integration');
		vi.doUnmock('../qr-modal');
	});

	it('groups push subscriptions under enabled devices', async () => {
		const { renderNotificationsSection } = await loadNotificationsSectionModule();
		const getPushSubscriptions = vi.fn(async () => ({
			subscriptions: [
				{
					id: 'sub-1',
					device_name: 'iPhone',
					created_at: '2026-06-04 12:00:00',
				},
			],
		}));
		const containerEl = new FakeElement('div');

		renderNotificationsSection({
			containerEl: containerEl as never,
			plugin: createPlugin({
				getPushSubscriptions,
				deletePushSubscription: vi.fn(),
				testPush: vi.fn(async () => ({ sent: 1, failed: 0, pruned: 0, errors: [] })),
			}),
			rerender: vi.fn(),
		});
		await flushMicrotasks();

		expect(getSettingByName('Enable push notifications')).toBeTruthy();
		expect(getSettingByName('Reminders web app').descEl.textContent).toContain('short-lived link');
		expect(getSettingByName('Enabled devices').descEl.textContent).toContain('receive reminder push notifications');
		expect(getSettingByName('iPhone').descEl.textContent).toContain('Subscribed');
		expect(getSettingByName('Test notification').descEl.textContent).toBe('Send a test push to all enabled devices');
	});

	it('removes enabled notification devices through the push subscription API', async () => {
		const { renderNotificationsSection } = await loadNotificationsSectionModule();
		const getPushSubscriptions = vi.fn(async () => ({
			subscriptions: [
				{
					id: 'sub-1',
					device_name: 'iPhone',
					created_at: '2026-06-04 12:00:00',
				},
			],
		}));
		const deletePushSubscription = vi.fn(async () => ({ success: true }));

		renderNotificationsSection({
			containerEl: new FakeElement('div') as never,
			plugin: createPlugin({
				getPushSubscriptions,
				deletePushSubscription,
				testPush: vi.fn(async () => ({ sent: 0, failed: 0, pruned: 0, errors: [] })),
			}),
			rerender: vi.fn(),
		});
		await flushMicrotasks();

		getSettingByName('iPhone').buttons[0]?.click();
		await flushMicrotasks();

		expect(deletePushSubscription).toHaveBeenCalledWith('sub-1');
		expect(getPushSubscriptions).toHaveBeenCalledTimes(2);
	});

	it('uses enabled-device wording when no push subscriptions exist', async () => {
		const { renderNotificationsSection } = await loadNotificationsSectionModule();
		const containerEl = new FakeElement('div');

		renderNotificationsSection({
			containerEl: containerEl as never,
			plugin: createPlugin({
				getPushSubscriptions: vi.fn(async () => ({ subscriptions: [] })),
				deletePushSubscription: vi.fn(),
				testPush: vi.fn(async () => ({ sent: 0, failed: 0, pruned: 0, errors: [] })),
			}),
			rerender: vi.fn(),
		});
		await flushMicrotasks();

		expect(containerEl.collectText()).toContain('No enabled devices yet.');

		getSettingByName('Test notification').buttons[0]?.click();
		await flushMicrotasks();

		expect(noticeMessages).toContain('No enabled devices found. Enable notifications in the web app first.');
	});
});

function createPlugin(apiClient: Record<string, unknown>): never {
	return {
		app: {},
		settings: {
			pushEnabled: true,
			workerUrl: 'https://worker.example.com',
		},
		remindersSettings: {
			allDayNotificationTime: '09:00',
			remindersFolderPath: 'Reminders',
			upcomingDaysDefault: 7,
		},
		saveSettings: vi.fn(),
		writeRemindersSettings: vi.fn(),
		syncRuntime: {
			getApiClient: () => ({
				createRemindersEnrollmentToken: vi.fn(async () => ({
					token: 'enroll-token',
					expiresAt: '2026-06-13T12:00:00.000Z',
				})),
				...apiClient,
			}),
		},
	} as never;
}
