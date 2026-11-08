import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	FakeElement,
	openSettingsDisclosures,
	MockSetting,
	createObsidianUiModule,
	noticeMessages,
	resetObsidianUiMocks,
} from '../../test/fakes/obsidian-ui';
import { createSettingsUiState } from '../../plugin/settings-ui-state';

let lastQrCodeData: string | null = null;
const openExternalBrowserModal = vi.fn();

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

const confirmRemoval = vi.fn(async (_app: unknown, _options: { title: string }) => true);
async function loadNotificationsSectionModule(expand = true) {
	vi.doMock('obsidian', () => createObsidianUiModule());
	vi.doMock('./qr-modal', () => ({
		QRModal: class QRModal {
			constructor(_app: unknown, data: string) {
				lastQrCodeData = data;
			}
			open(): void {}
		},
	}));
	vi.doMock('./external-browser-modal', () => ({ openExternalBrowserModal }));
	vi.doMock('../plugin/confirmation-modal', () => ({ openConfirmationModal: confirmRemoval }));

	const notifications = await import('./notifications-section');
	return { ...await import('./reminders-web-app'), renderNotificationsSection: (context: Parameters<typeof notifications.renderNotificationsSection>[0]) => {
		const cleanup = notifications.renderNotificationsSection(context);
		if (expand) openSettingsDisclosures(context.containerEl as unknown as FakeElement);
		return cleanup;
	} };
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
		openExternalBrowserModal.mockClear();
	updateNotificationPolicy.mockClear();
	});

	afterEach(() => {
		vi.resetModules();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
		vi.doUnmock('obsidian');
		vi.doUnmock('./qr-modal');
		vi.doUnmock('./external-browser-modal');
	});

	it('keeps the push toggle and device controls inside the Notifications disclosure', async () => {
		const { renderNotificationsSection } = await loadNotificationsSectionModule(false);
		const getPushSubscriptions = vi.fn(async () => ({ subscriptions: [] }));
		const container = new FakeElement('div');
		const cleanup = renderNotificationsSection({ containerEl: container as never, plugin: createPlugin({ getPushSubscriptions }), rerender: vi.fn() });
		await flushMicrotasks();
		expect(getPushSubscriptions).not.toHaveBeenCalled();
		expect(MockSetting.instances).toHaveLength(0);
		expect(container.children[0]?.attributes.get('data-settings-section')).toBe('Notifications');
		expect(container.collectText()).toContain('On · schedule, timezone, and devices');
		openSettingsDisclosures(container);
		await flushMicrotasks();
		expect(getPushSubscriptions).toHaveBeenCalledOnce();
		expect(getSettingByName('Push notifications')).toBeTruthy();
		expect(container.collectText()).not.toContain('Notification options');
		openSettingsDisclosures(container);
		expect(getPushSubscriptions).toHaveBeenCalledOnce();
		cleanup();
	});

	it.each([null, '2026-09-06'])('shows notification enrollment and paused recovery state: %s', async disabled_at => {
		const { renderNotificationsSection } = await loadNotificationsSectionModule();
		const getPushSubscriptions = vi.fn(async () => ({
			subscriptions: [
				{
					id: 'sub-1',
					device_name: 'iPhone',
					created_at: '2026-06-04 12:00:00',
					disabled_at,
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

		expect(getSettingByName('Test notification').buttons[0]?.buttonEl.classNames.has('is-disabled')).toBe(Boolean(disabled_at));
		expect(getSettingByName('Push notifications')).toBeTruthy();
		expect(MockSetting.instances.some(setting => setting.nameEl.textContent === 'Crate web app')).toBe(false);
		expect(getSettingByName('Notification devices').descEl.textContent).toContain('receive reminder push notifications');
		expect(getSettingByName('iPhone').descEl.textContent).toContain(disabled_at ? 'Notifications paused. Remove this device' : 'Subscribed');
		expect(getSettingByName('Test notification').descEl.textContent).toBe('Send a test notification to all enabled devices.');
	});

	it('shows the subscription date from the server UTC timestamp', async () => {
		const originalTimezone = process.env.TZ;
		process.env.TZ = 'America/Los_Angeles';
		try {
			const { renderNotificationsSection } = await loadNotificationsSectionModule();
			const getPushSubscriptions = vi.fn(async () => ({ subscriptions: [{ id: 'sub-1', device_name: 'iPhone', created_at: '2026-06-04 02:00:00', disabled_at: null }] }));
			renderNotificationsSection({
				containerEl: new FakeElement('div') as never,
				plugin: createPlugin({ getPushSubscriptions, deletePushSubscription: vi.fn(), testPush: vi.fn() }),
				rerender: vi.fn(),
			});
			await flushMicrotasks();

			// 02:00 UTC on June 4 is still June 3 in Los Angeles.
			expect(getSettingByName('iPhone').descEl.textContent).toBe(`Subscribed ${new Date('2026-06-04T02:00:00Z').toLocaleDateString()}`);
		} finally {
			process.env.TZ = originalTimezone;
		}
	});

	it('ignores late subscription results after settings close', async () => {
		const { renderNotificationsSection } = await loadNotificationsSectionModule();
		let resolve!: (value: { subscriptions: unknown[] }) => void;
		const pending = new Promise<{ subscriptions: unknown[] }>(done => { resolve = done; });
		const container = new FakeElement('div');
		const cleanup = renderNotificationsSection({ containerEl: container as never,
			plugin: createPlugin({ getPushSubscriptions: () => pending }), rerender: vi.fn() });
		cleanup();
		resolve({ subscriptions: [{ id: 'late', device_name: 'Late phone', created_at: '2026-09-13' }] });
		await flushMicrotasks();
		expect(container.collectText()).not.toContain('Late phone');
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
		expect(plugin.writeRemindersSettings).toHaveBeenCalledWith({ allDayNotificationTime: null }, expect.any(Function));
		expect(setting.texts[0]?.inputEl.value).toBe('');
	});

	it('saves an edited all-day time once, with the field disabled while it saves', async () => {
		const { renderNotificationsSection } = await loadNotificationsSectionModule();
		const plugin = createPlugin({ getPushSubscriptions: vi.fn(async () => ({ subscriptions: [] })) }) as unknown as { writeRemindersSettings: ReturnType<typeof vi.fn> };
		renderNotificationsSection({ containerEl: new FakeElement('div') as never, plugin: plugin as never, rerender: vi.fn() });
		await flushMicrotasks();
		const input = getSettingByName('All-day notification time').texts[0]!.inputEl;
		let release!: () => void;
		updateNotificationPolicy.mockImplementationOnce(policy => new Promise(resolve => { release = () => resolve({ policy: { ...policy, revision: 'policy-2' } }); }));

		input.value = '10:30';
		input.blur();
		await flushMicrotasks();
		expect(input.disabled).toBe(true);
		input.blur(); // Before: a second blur started another save.
		release();
		await flushMicrotasks();
		expect(updateNotificationPolicy).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ allDayTime: '10:30' }));
		expect(plugin.writeRemindersSettings).toHaveBeenCalledExactlyOnceWith({ allDayNotificationTime: '10:30' }, expect.any(Function));
		expect(input).toMatchObject({ value: '10:30', disabled: false });

		updateNotificationPolicy.mockRejectedValueOnce(new Error('Offline'));
		input.value = '';
		input.blur();
		await flushMicrotasks();
		expect(noticeMessages).toContain('Failed to save notification time: Offline');
		expect(input.value).toBe('10:30');
	});

	it('updates the shared policy before saving the local notification preference', async () => {
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
		getSettingByName('Push notifications').toggles[0]?.change(false);
		await flushMicrotasks();

		expect(updateNotificationPolicy).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, revision: 'policy-1' }));
		expect(plugin.writeSettings).toHaveBeenCalledWith({ pushEnabled: false }, expect.any(Function));
		expect(updateNotificationPolicy.mock.invocationCallOrder[0]).toBeLessThan(
			plugin.writeSettings.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
		);
	});

	it('does not save the local preference after the server connection changes', async () => {
		const { renderNotificationsSection } = await loadNotificationsSectionModule();
		const plugin = createPlugin({ getPushSubscriptions: vi.fn(async () => ({ subscriptions: [] })) }) as unknown as {
			settings: { pushEnabled: boolean; workerUrl: string };
			writeSettings: ReturnType<typeof vi.fn>;
		};
		// The real write checks the connection before saving.
		plugin.writeSettings.mockImplementationOnce((_update: unknown, assertCurrent: () => void) => { assertCurrent(); });
		updateNotificationPolicy.mockImplementationOnce(async (policy: Record<string, unknown>) => {
			plugin.settings.workerUrl = 'https://other.example.com';
			return { policy: { ...policy, revision: 'policy-2' } };
		});

		renderNotificationsSection({ containerEl: new FakeElement('div') as never, plugin: plugin as never, rerender: vi.fn() });
		getSettingByName('Push notifications').toggles[0]?.change(false);
		await flushMicrotasks();

		expect(plugin.settings.pushEnabled).toBe(true);
		expect(noticeMessages.some(message => message.includes('server connection changed'))).toBe(true);
	});

	it('retains the shared server choice when saving the local preference fails', async () => {
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
		getSettingByName('Push notifications').toggles[0]?.change(false);
		await flushMicrotasks();

		expect(plugin.settings.pushEnabled).toBe(true);
	expect(getSettingByName('Push notifications').toggles[0]?.value).toBe(false);
	expect(noticeMessages.some(message => message.includes('disk full'))).toBe(true);
	});

	it('reuses the shared policy across settings re-renders while settings stay open', async () => {
		const { renderNotificationsSection } = await loadNotificationsSectionModule();
		const plugin = createPlugin({ getPushSubscriptions: vi.fn(async () => ({ subscriptions: [] })) }) as unknown as {
			remindersSettings: { remindersFolderPath: string };
			settingsUiState: ReturnType<typeof createSettingsUiState>;
			syncRuntime: { getApiClient(): { getNotificationPolicy: ReturnType<typeof vi.fn> } };
		};
		const render = () => renderNotificationsSection({ containerEl: new FakeElement('div') as never, plugin: plugin as never, rerender: vi.fn() });
		const getNotificationPolicy = plugin.syncRuntime.getApiClient().getNotificationPolicy;
		render(); render();
		await flushMicrotasks();
		// Before: every toggle elsewhere in settings fetched the policy again.
		expect(getNotificationPolicy).toHaveBeenCalledOnce();

		// A saved change becomes the reused policy, so the next save sends its new revision.
		getSettingByName('Push notifications').toggles[0]?.change(false);
		await flushMicrotasks();
		render();
		await flushMicrotasks();
		[...MockSetting.instances].reverse().find(setting => setting.nameEl.textContent === 'Push notifications')!.toggles[0]?.change(true);
		await flushMicrotasks();
		expect(updateNotificationPolicy).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true, revision: 'policy-2' }));
		expect(getNotificationPolicy).toHaveBeenCalledOnce();

		// Moving the reminders folder updates the server's policy, and so does closing settings.
		plugin.remindersSettings.remindersFolderPath = 'Tasks';
		render();
		expect(getNotificationPolicy).toHaveBeenCalledTimes(2);
		plugin.settingsUiState.notificationPolicy = null; // What CrateSettingTab.hide() does.
		render();
		expect(getNotificationPolicy).toHaveBeenCalledTimes(3);
	});

	it('loads the shared policy again after a save fails', async () => {
		const { renderNotificationsSection } = await loadNotificationsSectionModule();
		const plugin = createPlugin({ getPushSubscriptions: vi.fn(async () => ({ subscriptions: [] })) }) as unknown as {
			syncRuntime: { getApiClient(): { getNotificationPolicy: ReturnType<typeof vi.fn> } };
		};
		const render = () => renderNotificationsSection({ containerEl: new FakeElement('div') as never, plugin: plugin as never, rerender: vi.fn() });
		render();
		updateNotificationPolicy.mockRejectedValueOnce(new Error('Notification settings changed on another device. Refresh before saving.'));
		getSettingByName('Push notifications').toggles[0]?.change(false);
		await flushMicrotasks();
		render();
		expect(plugin.syncRuntime.getApiClient().getNotificationPolicy).toHaveBeenCalledTimes(2);
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

		confirmRemoval.mockResolvedValueOnce(false);
		getSettingByName('iPhone').buttons[0]?.click();
		await flushMicrotasks();
		expect(confirmRemoval).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: 'Remove notification subscription' }));
		expect(deletePushSubscription).not.toHaveBeenCalled();

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

		expect(getSettingByName('Test notification').buttons[0]?.buttonEl.classNames.has('is-disabled')).toBe(true);
		expect(noticeMessages).toEqual([]);
	});

	it('replaces the device list with one error when a refresh fails', async () => {
		const { renderNotificationsSection } = await loadNotificationsSectionModule();
		const getPushSubscriptions = vi.fn(async () => ({ subscriptions: [{ id: 'sub-1', device_name: 'iPhone', created_at: '2026-06-04 12:00:00', disabled_at: null }] }));
		const containerEl = new FakeElement('div');
		renderNotificationsSection({ containerEl: containerEl as never, plugin: createPlugin({ getPushSubscriptions }), rerender: vi.fn() });
		await flushMicrotasks();
		expect(containerEl.collectText()).toContain('iPhone');

		getPushSubscriptions.mockRejectedValue(new Error('Offline'));
		const refresh = getSettingByName('Notification devices').buttons[0]!;
		refresh.click(); await flushMicrotasks();
		refresh.click(); await flushMicrotasks();

		// Before: the old rows stayed, with one more error line per failed refresh.
		const list = containerEl.querySelector('.crate-push-subscriptions')!;
		expect(list.collectText()).not.toContain('iPhone');
		expect(list.collectText().match(/Failed to load subscriptions\./g)).toHaveLength(1);
		expect(getSettingByName('Test notification').buttons[0]?.buttonEl.classNames.has('is-disabled')).toBe(true);
	});

	it('shows the Worker error when an app code cannot be created', async () => {
		const { renderCrateWebApp } = await loadNotificationsSectionModule();
		renderCrateWebApp({ containerEl: new FakeElement('div') as never, plugin: createPlugin({
				serverFolder: async (folderPath: string) => ({ folderPath }),
				createRemindersEnrollmentToken: vi.fn(async () => {
					throw new Error('Invalid token');
				}),
				getPushSubscriptions: vi.fn(async () => ({ subscriptions: [] })),
				deletePushSubscription: vi.fn(),
				testPush: vi.fn(async () => ({ sent: 0, failed: 0, pruned: 0, errors: [] })),
			}) });
		await flushMicrotasks();

		const showCodeButton = getSettingByName('Crate web app').buttons[1];
		showCodeButton?.click();
		await flushMicrotasks();

		expect(noticeMessages).toContain('Could not create app code: Invalid token');
		expect(showCodeButton?.buttonEl.textContent).toBe('Connect another device');
		expect(showCodeButton?.buttonEl.classNames.has('is-disabled')).toBe(false);
	});

	it('shows the setup link as a QR code to connect another device', async () => {
		const { renderCrateWebApp } = await loadNotificationsSectionModule();
		renderCrateWebApp({ containerEl: new FakeElement('div') as never, plugin: createPlugin({}) });
		getSettingByName('Crate web app').buttons[1]?.click();
		await flushMicrotasks();
		// plugin/web-app-enrollment.test.ts covers the link itself.
		expect(lastQrCodeData).toContain('https://worker.example.com/notifications?token=install-token');
	});

	it('opens the reminders app directly in the browser after the enrollment request', async () => {
		const { renderCrateWebApp } = await loadNotificationsSectionModule();
		const open = vi.fn();
		vi.stubGlobal('window', { open });
		const plugin = createPlugin({}) as unknown as { app: unknown };
		renderCrateWebApp({ containerEl: new FakeElement('div') as never, plugin: plugin as never });
		getSettingByName('Crate web app').buttons[0]?.click();
		await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
		expect(open).toHaveBeenCalledWith(
			expect.stringContaining('/notifications?token=install-token'),
			'_blank', 'noopener,noreferrer');
		expect(openExternalBrowserModal).not.toHaveBeenCalled();
	});

});

const updateNotificationPolicy = vi.fn(async (policy: Record<string, unknown>) => ({ policy: { ...policy, revision: 'policy-2' } }));

function createPlugin(apiClient: Record<string, unknown>): never {
	let stableApi: Record<string, unknown> | undefined;
	const plugin = {
		secretStorage: { get: vi.fn(() => null) },
		app: {},
		settingsUiState: createSettingsUiState(),
		settings: {
			pushEnabled: true,
			workerUrl: 'https://worker.example.com',
			reading: { folderPath: 'Reading' },
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
			getApiClient: () => stableApi ??= ({
				getNotificationPolicy: vi.fn(async () => ({ policy: { folderPath: 'Reminders', timezone: 'America/New_York', allDayTime: '09:00', revision: 'policy-1', enabled: true } })),
		ensureNotificationPolicy: vi.fn(async (policy: unknown) => ({ policy })),
		updateNotificationPolicy,
		getWorkerUrl: vi.fn(() => 'https://worker.example.com'),
				serverFolder: async (folderPath: string) => ({ folderPath }),
				createRemindersEnrollmentToken: vi.fn(async () => ({
					token: 'install-token',
					browserToken: 'browser-token',
					expiresAt: '2026-06-13T12:00:00.000Z',
				})),
				...apiClient,
			}),
		},
	};
	return plugin as never;
}
