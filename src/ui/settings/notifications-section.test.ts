import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	FakeElement,
	MockSetting,
	createObsidianUiModule,
	noticeMessages,
	resetObsidianUiMocks,
} from '../../test/fakes/obsidian-ui';

let lastQrCodeData: string | null = null;
const disableReminderNotifications = vi.fn();
const enableReminderNotifications = vi.fn();
const reconcileReminderNotifications = vi.fn();

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function loadNotificationsSectionModule() {
	vi.doMock('obsidian', () => createObsidianUiModule());
	vi.doMock('../../reminders/plugin-integration', () => ({
		disableReminderNotifications,
		enableReminderNotifications,
		reconcileReminderNotifications,
	}));
	vi.doMock('../qr-modal', () => ({
		QRModal: class QRModal {
			constructor(_app: unknown, data: string) {
				lastQrCodeData = data;
			}
			open(): void {}
		},
	}));

	return { ...await import('./notifications-section'), ...await import('./reminders-web-app') };
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
		lastQrCodeData = null;
    updateNotificationPolicy.mockClear();
		disableReminderNotifications.mockReset();
		enableReminderNotifications.mockReset();
		reconcileReminderNotifications.mockReset();
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
		expect(MockSetting.instances.some(setting => setting.nameEl.textContent === 'Reminders web app')).toBe(false);
		expect(getSettingByName('Notification devices').descEl.textContent).toContain('receive reminder push notifications');
		expect(getSettingByName('iPhone').descEl.textContent).toContain('Subscribed');
		expect(getSettingByName('Test notification').descEl.textContent).toBe('Send a test notification to all enabled devices.');
	});

	it('provides a time picker and an explicit way to turn all-day notifications off', async () => {
		const { renderNotificationsSection } = await loadNotificationsSectionModule();
		const plugin = createPlugin({
			getPushSubscriptions: vi.fn(async () => ({ subscriptions: [] })),
		}) as unknown as { writeRemindersSettings: ReturnType<typeof vi.fn> };
		renderNotificationsSection({
			containerEl: new FakeElement('div') as never,
			plugin: plugin as never,
			rerender: vi.fn(),
		});
		const setting = getSettingByName('All-day notification time');
		expect(setting.texts[0]?.inputEl.type).toBe('time');
		setting.buttons[0]?.click();
		await flushMicrotasks();
		expect(plugin.writeRemindersSettings).toHaveBeenCalledWith({ allDayNotificationTime: null });
		expect(setting.texts[0]?.inputEl.value).toBe('');
		expect(reconcileReminderNotifications).toHaveBeenCalled();
	});

	it('updates the shared policy before saving the local notification preference', async () => {
		disableReminderNotifications.mockResolvedValue(undefined);
		const { renderNotificationsSection } = await loadNotificationsSectionModule();
		const plugin = createPlugin({
			getPushSubscriptions: vi.fn(async () => ({ subscriptions: [] })),
			deletePushSubscription: vi.fn(),
			testPush: vi.fn(async () => ({ sent: 0, failed: 0, pruned: 0, errors: [] })),
		}) as unknown as {
			writeSettings: ReturnType<typeof vi.fn>;
		};

		renderNotificationsSection({
			containerEl: new FakeElement('div') as never,
			plugin: plugin as never,
			rerender: vi.fn(),
		});
		getSettingByName('Enable push notifications').toggles[0]?.change(false);
		await flushMicrotasks();

		expect(updateNotificationPolicy).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, revision: 'policy-1' }));
		expect(plugin.writeSettings).toHaveBeenCalledWith({ pushEnabled: false });
		expect(updateNotificationPolicy.mock.invocationCallOrder[0]).toBeLessThan(
			plugin.writeSettings.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
		);
	});

	it('retains the shared server choice when saving the local preference fails', async () => {
		disableReminderNotifications.mockResolvedValue(undefined);
		const { renderNotificationsSection } = await loadNotificationsSectionModule();
		const plugin = createPlugin({
			getPushSubscriptions: vi.fn(async () => ({ subscriptions: [] })),
			deletePushSubscription: vi.fn(),
			testPush: vi.fn(async () => ({ sent: 0, failed: 0, pruned: 0, errors: [] })),
		}) as unknown as {
			settings: { pushEnabled: boolean };
			writeSettings: ReturnType<typeof vi.fn>;
		};
		plugin.writeSettings.mockRejectedValueOnce(new Error('disk full'));

		renderNotificationsSection({
			containerEl: new FakeElement('div') as never,
			plugin: plugin as never,
			rerender: vi.fn(),
		});
		getSettingByName('Enable push notifications').toggles[0]?.change(false);
		await flushMicrotasks();

		expect(plugin.settings.pushEnabled).toBe(true);
		expect(enableReminderNotifications).not.toHaveBeenCalled();
    expect(getSettingByName('Enable push notifications').toggles[0]?.value).toBe(false);
    expect(noticeMessages.some(message => message.includes('disk full'))).toBe(true);
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

	it('shows the Worker error when an app code cannot be created', async () => {
		const { renderRemindersWebApp } = await loadNotificationsSectionModule();
		renderRemindersWebApp(new FakeElement('div') as never, createPlugin({
				createRemindersEnrollmentToken: vi.fn(async () => {
					throw new Error('Invalid token');
				}),
				getPushSubscriptions: vi.fn(async () => ({ subscriptions: [] })),
				deletePushSubscription: vi.fn(),
				testPush: vi.fn(async () => ({ sent: 0, failed: 0, pruned: 0, errors: [] })),
			}));
		await flushMicrotasks();

		const showCodeButton = getSettingByName('Reminders web app').buttons[1];
		showCodeButton?.click();
		await flushMicrotasks();

		expect(noticeMessages).toContain('Could not create app code: Invalid token');
		expect(showCodeButton?.buttonEl.textContent).toBe('Show code');
		expect(showCodeButton?.buttonEl.classNames.has('is-disabled')).toBe(false);
	});

	it('builds the app code from the active API endpoint when persisted settings are stale', async () => {
		const { renderRemindersWebApp } = await loadNotificationsSectionModule();
		const plugin = createPlugin({
			getWorkerUrl: vi.fn(() => 'https://active-worker.example.com'),
			getPushSubscriptions: vi.fn(async () => ({ subscriptions: [] })),
			deletePushSubscription: vi.fn(),
			testPush: vi.fn(async () => ({ sent: 0, failed: 0, pruned: 0, errors: [] })),
		}) as unknown as { settings: { workerUrl: string; pushEnabled: boolean } };
		plugin.settings.workerUrl = '';
		plugin.settings.pushEnabled = false;

		renderRemindersWebApp(new FakeElement('div') as never, plugin as never);
		await flushMicrotasks();

		getSettingByName('Reminders web app').buttons[1]?.click();
		await flushMicrotasks();

		expect(lastQrCodeData).toBe(
			'https://active-worker.example.com/notifications?token=install-token&browserToken=browser-token&folder=Reminders&upcomingDays=7&allDayTime=09%3A00',
		);
	});
});

const updateNotificationPolicy = vi.fn(async (policy: Record<string, unknown>) => ({ policy: { ...policy, revision: 'policy-2' } }));

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
		writeSettings: vi.fn(async function (this: { settings: { pushEnabled: boolean } }, update: { pushEnabled: boolean }) {
			this.settings.pushEnabled = update.pushEnabled;
		}),
		writeRemindersSettings: vi.fn(),
		syncRuntime: {
			getApiClient: () => ({
				getNotificationPolicy: vi.fn(async () => ({ policy: { folderPath: 'Reminders', timezone: 'America/New_York', allDayTime: '09:00', revision: 'policy-1', enabled: true } })),
        ensureNotificationPolicy: vi.fn(async (policy: unknown) => ({ policy })),
        updateNotificationPolicy,
        getWorkerUrl: vi.fn(() => 'https://worker.example.com'),
				createRemindersEnrollmentToken: vi.fn(async () => ({
					token: 'install-token',
					browserToken: 'browser-token',
					expiresAt: '2026-06-13T12:00:00.000Z',
				})),
				...apiClient,
			}),
		},
	} as never;
}
