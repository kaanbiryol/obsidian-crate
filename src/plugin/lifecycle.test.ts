import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const noticeMessages: Array<string | object> = [];
type ProtocolHandler = (params: Record<string, string>) => void;
type SyncRuntimeTarget = {
	syncRuntime?: {
		isConfigured: () => boolean;
		initialize: () => Promise<void>;
		waitForStartupSync: () => Promise<boolean>;
		destroy?: () => void;
	};
};

const initializeReminders = vi.fn();
const ensureReminderNotificationPolicy = vi.fn();
const initializeSyncManagers = vi.fn<(target: SyncRuntimeTarget) => void>();
const registerSyncCommands = vi.fn();
const registerVaultSyncEventHandlers = vi.fn();
const ensurePluginDeviceId = vi.fn();
const handleCloudflareOAuthProtocol = vi.fn();
const showCloudflareServerUpdateNotice = vi.fn();
const cloudflareDeploymentDestroy = vi.fn();
const createCloudflareDeploymentService = vi.fn(() => ({
	destroy: cloudflareDeploymentDestroy,
}));
const secretStorageHas = vi.fn(() => false);

class FakeDocumentFragment {
	readonly spans: string[] = [];
	readonly links: Array<{ text: string; addEventListener: ReturnType<typeof vi.fn> }> = [];

	createSpan(options: { text: string }): void {
		this.spans.push(options.text);
	}

	createEl(tag: string, options: { text: string }) {
		const link = {
			tag,
			text: options.text,
			addEventListener: vi.fn(),
		};
		this.links.push(link);
		return link;
	}
}

async function loadLifecycleModule() {
	vi.doMock('obsidian', () => ({
		Notice: class Notice {
			constructor(message?: string | object) {
				if (message) {
					noticeMessages.push(message);
				}
			}
		},
	}));
	vi.doMock('./secret-storage', () => ({
		SecretStorageService: class SecretStorageService {
			constructor(public readonly app: unknown) {}
			has = secretStorageHas;
		},
	}));
	vi.doMock('./logger', () => ({
		createLogger: vi.fn(() => ({
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		})),
		errorMessage: vi.fn((error: unknown) => String(error)),
	}));
	vi.doMock('../ui/settings-tab', () => ({
		CrateSettingTab: class CrateSettingTab {
			constructor(public readonly app: unknown, public readonly plugin: unknown) {}
		},
	}));
	vi.doMock('../reminders/plugin-integration', () => ({
		initializeReminders,
		ensureReminderNotificationPolicy,
	}));
	vi.doMock('../sync/plugin-integration', () => ({
		initializeSyncManagers,
		registerSyncCommands,
		registerVaultSyncEventHandlers,
	}));
	vi.doMock('./deviceId', () => ({
		ensurePluginDeviceId,
	}));
	vi.doMock('../cloudflare/plugin-integration', () => ({
		createCloudflareDeploymentService,
		handleCloudflareOAuthProtocol,
	}));
	vi.doMock('../cloudflare/update-notice', () => ({ showCloudflareServerUpdateNotice }));

	return import('./lifecycle');
}

function createPlugin(overrides: Record<string, unknown> = {}) {
	return {
		app: {
			setting: {
				open: vi.fn(),
				openTabById: vi.fn(),
			},
		},
		manifest: {
			id: 'crate',
		},
		loadSettings: vi.fn(async () => {}),
		remindersSettings: { enabled: true },
		registerSettingsTab: vi.fn(),
		openSettingsTab: vi.fn(),
		activateRemindersView: vi.fn(async () => {}),
		registerObsidianProtocolHandler: vi.fn(),
		...overrides,
	};
}

beforeEach(() => {
	noticeMessages.length = 0;
	initializeReminders.mockReset().mockImplementation(async (target: {
		reminderIndex?: { load: () => Promise<void> };
	}) => {
		target.reminderIndex ??= { load: vi.fn(async () => undefined) };
	});
	ensureReminderNotificationPolicy.mockReset();
	initializeSyncManagers.mockReset();
	registerSyncCommands.mockReset();
	registerVaultSyncEventHandlers.mockReset();
	ensurePluginDeviceId.mockReset();
	handleCloudflareOAuthProtocol.mockReset();
	showCloudflareServerUpdateNotice.mockReset();
	cloudflareDeploymentDestroy.mockReset();
	createCloudflareDeploymentService.mockClear();
	secretStorageHas.mockReset().mockReturnValue(false);
	vi.stubGlobal('DocumentFragment', FakeDocumentFragment as unknown as typeof DocumentFragment);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
	vi.clearAllMocks();
	vi.doUnmock('obsidian');
	vi.doUnmock('./secret-storage');
	vi.doUnmock('./logger');
	vi.doUnmock('../ui/settings-tab');
	vi.doUnmock('../reminders/plugin-integration');
	vi.doUnmock('../sync/plugin-integration');
	vi.doUnmock('./deviceId');
	vi.doUnmock('../cloudflare/plugin-integration');
	vi.doUnmock('../cloudflare/update-notice');
});

describe('bootstrapPlugin', () => {
	it('initializes configured plugins and wires protocol handlers', async () => {
		const { bootstrapPlugin } = await loadLifecycleModule();
		const syncInitialize = vi.fn(async () => {});
		const plugin = createPlugin();

		initializeSyncManagers.mockImplementation((target) => {
			target.syncRuntime = {
				isConfigured: vi.fn(() => true),
				initialize: syncInitialize,
				waitForStartupSync: vi.fn(async () => false),
			};
		});

		await bootstrapPlugin(plugin as never);

		expect(plugin.loadSettings).toHaveBeenCalledTimes(1);
		expect(ensurePluginDeviceId).toHaveBeenCalledWith(plugin);
		expect(plugin.registerSettingsTab).toHaveBeenCalledTimes(1);
		expect(registerVaultSyncEventHandlers).toHaveBeenCalledWith(plugin);
		expect(syncInitialize).toHaveBeenCalledTimes(1);
		expect(registerSyncCommands).toHaveBeenCalledWith(plugin);
		expect(initializeReminders).toHaveBeenCalledWith(plugin);
		await vi.waitFor(() => {
			expect(ensureReminderNotificationPolicy).toHaveBeenCalledWith(plugin);
		});
		expect(createCloudflareDeploymentService).toHaveBeenCalledWith(plugin);
		expect(showCloudflareServerUpdateNotice).toHaveBeenCalledWith(plugin);
		expect(plugin.registerObsidianProtocolHandler).toHaveBeenCalledTimes(2);

		const remindersHandler = plugin.registerObsidianProtocolHandler.mock.calls.find(
			([name]) => name === 'crate-reminders',
		)?.[1] as ProtocolHandler | undefined;
		const cloudflareHandler = plugin.registerObsidianProtocolHandler.mock.calls.find(
			([name]) => name === 'crate-cloudflare-oauth',
		)?.[1] as ProtocolHandler | undefined;

		expect(typeof remindersHandler).toBe('function');
		expect(typeof cloudflareHandler).toBe('function');

		remindersHandler?.({ project: 'Work' });
		cloudflareHandler?.({ code: 'authorization-code', state: 'oauth-state' });

		expect(plugin.activateRemindersView).toHaveBeenCalledWith('Work');
		expect(handleCloudflareOAuthProtocol).toHaveBeenCalledWith(plugin, {
			code: 'authorization-code',
			state: 'oauth-state',
		});
	});

	it('shows the setup notice instead of starting sync when the plugin is not configured', async () => {
		const { bootstrapPlugin } = await loadLifecycleModule();
		const syncInitialize = vi.fn(async () => {});
		const plugin = createPlugin();

		initializeSyncManagers.mockImplementation((target) => {
			target.syncRuntime = {
				isConfigured: vi.fn(() => false),
				initialize: syncInitialize,
				waitForStartupSync: vi.fn(async () => false),
			};
		});

		await bootstrapPlugin(plugin as never);

		expect(syncInitialize).not.toHaveBeenCalled();
		expect(initializeReminders).toHaveBeenCalledWith(plugin);
		expect(noticeMessages).toHaveLength(1);
		expect(noticeMessages[0]).toBeInstanceOf(FakeDocumentFragment);
	});

	it('does not scan reminder files until a new user enables reminders', async () => {
		const { bootstrapPlugin } = await loadLifecycleModule();
		const plugin = createPlugin({
			remindersSettings: { enabled: false },
		});

		initializeSyncManagers.mockImplementation((target) => {
			target.syncRuntime = {
				isConfigured: vi.fn(() => true),
				initialize: vi.fn(async () => undefined),
				waitForStartupSync: vi.fn(async () => false),
			};
		});

		await bootstrapPlugin(plugin as never);
		await Promise.resolve();

		expect(initializeReminders).not.toHaveBeenCalled();
		expect(ensureReminderNotificationPolicy).not.toHaveBeenCalled();

		const remindersHandler = plugin.registerObsidianProtocolHandler.mock.calls.find(
			([name]) => name === 'crate-reminders',
		)?.[1] as ProtocolHandler | undefined;
		remindersHandler?.({ project: 'Work' });

		expect(plugin.activateRemindersView).not.toHaveBeenCalled();
		expect(plugin.openSettingsTab).toHaveBeenCalledTimes(1);
		expect(noticeMessages).toContain(
			'Enable reminders in Crate settings before opening the reminders app.',
		);
	});

	it('reloads the reminder index and initializes policy only after startup sync finishes', async () => {
		const { bootstrapPlugin } = await loadLifecycleModule();
		let finishStartupSync!: (ran: boolean) => void;
		const startupSync = new Promise<boolean>((resolve) => {
			finishStartupSync = resolve;
		});
		const reminderIndexLoad = vi.fn(async () => undefined);
		const plugin = createPlugin({
			reminderIndex: { load: reminderIndexLoad },
		});

		initializeSyncManagers.mockImplementation((target) => {
			target.syncRuntime = {
				isConfigured: vi.fn(() => true),
				initialize: vi.fn(async () => undefined),
				waitForStartupSync: vi.fn(() => startupSync),
			};
		});

		await bootstrapPlugin(plugin as never);

		expect(reminderIndexLoad).not.toHaveBeenCalled();
		expect(ensureReminderNotificationPolicy).not.toHaveBeenCalled();

		finishStartupSync(true);
		await vi.waitFor(() => {
			expect(reminderIndexLoad).toHaveBeenCalledTimes(1);
			expect(ensureReminderNotificationPolicy).toHaveBeenCalledWith(plugin);
		});
		expect(reminderIndexLoad.mock.invocationCallOrder[0]).toBeLessThan(
			ensureReminderNotificationPolicy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
		);
	});

	it('does not reconcile after the plugin unloads during startup sync', async () => {
		const { bootstrapPlugin, shutdownPlugin } = await loadLifecycleModule();
		let finishStartupSync!: (ran: boolean) => void;
		const startupSync = new Promise<boolean>((resolve) => {
			finishStartupSync = resolve;
		});
		const reminderIndexLoad = vi.fn(async () => undefined);
		const syncDestroy = vi.fn();
		const plugin = createPlugin({
			reminderIndex: { load: reminderIndexLoad },
		});

		initializeSyncManagers.mockImplementation((target) => {
			target.syncRuntime = {
				isConfigured: vi.fn(() => true),
				initialize: vi.fn(async () => undefined),
				waitForStartupSync: vi.fn(() => startupSync),
				destroy: syncDestroy,
			};
		});

		await bootstrapPlugin(plugin as never);
		shutdownPlugin(plugin as never);
		finishStartupSync(true);
		await Promise.resolve();
		await Promise.resolve();

		expect(syncDestroy).toHaveBeenCalledTimes(1);
		expect(reminderIndexLoad).not.toHaveBeenCalled();
		expect(ensureReminderNotificationPolicy).not.toHaveBeenCalled();
	});

	it('restores a managed Worker URL when an earlier save kept only the scoped credential', async () => {
		const { bootstrapPlugin } = await loadLifecycleModule();
		const settings = {
			workerUrl: '',
			cloudflareDeployment: {
				deploymentId: '0123456789abcdef',
				workerName: 'crate-0123456789abcdef',
				workersSubdomain: 'example-account',
			},
		};
		const saveSettings = vi.fn(async () => {});
		const writeSettings = vi.fn(async (update: Partial<typeof settings>) => {
			Object.assign(settings, update);
		});
		const plugin = createPlugin({
			settings,
			loadSettings: vi.fn(async () => {}),
			saveSettings,
			writeSettings,
		});
		secretStorageHas.mockReturnValue(true);
		initializeSyncManagers.mockImplementation((target) => {
			target.syncRuntime = {
				isConfigured: vi.fn(() => true),
				initialize: vi.fn(async () => {}),
				waitForStartupSync: vi.fn(async () => false),
			};
		});

		await bootstrapPlugin(plugin as never);

		expect(settings.workerUrl).toBe(
			'https://crate-0123456789abcdef.example-account.workers.dev',
		);
		expect(writeSettings).toHaveBeenCalledWith({
			workerUrl: 'https://crate-0123456789abcdef.example-account.workers.dev',
		});
		expect(saveSettings).not.toHaveBeenCalled();
	});

	it('stops bootstrapping when core initialization fails', async () => {
		const { bootstrapPlugin } = await loadLifecycleModule();
		const plugin = createPlugin({
			loadSettings: vi.fn(async () => {
				throw new Error('settings unavailable');
			}),
		});

		await bootstrapPlugin(plugin as never);

		expect(initializeSyncManagers).not.toHaveBeenCalled();
		expect(ensurePluginDeviceId).not.toHaveBeenCalled();
		expect(plugin.registerSettingsTab).not.toHaveBeenCalled();
		expect(registerVaultSyncEventHandlers).not.toHaveBeenCalled();
		expect(registerSyncCommands).not.toHaveBeenCalled();
		expect(initializeReminders).not.toHaveBeenCalled();
		expect(showCloudflareServerUpdateNotice).not.toHaveBeenCalled();
		expect(noticeMessages).toContain('Crate failed to initialize: Error: settings unavailable');
	});
});

describe('shutdownPlugin', () => {
	it('destroys the sync runtime and unregisters the reminders watcher', async () => {
		const { shutdownPlugin } = await loadLifecycleModule();
		const destroy = vi.fn();
		const unregister = vi.fn();

		shutdownPlugin({
			syncRuntime: { destroy },
			cloudflareDeploymentService: { destroy: cloudflareDeploymentDestroy },
			remindersVaultWatcher: { unregister },
		} as never);

		expect(destroy).toHaveBeenCalledTimes(1);
		expect(cloudflareDeploymentDestroy).toHaveBeenCalledTimes(1);
		expect(unregister).toHaveBeenCalledTimes(1);
	});
});

it.each(['connection restore', 'reminders', 'sync'])('stops startup after shutdown during %s', async stage => {
  const { bootstrapPlugin, shutdownPlugin } = await loadLifecycleModule();
  let entered!: () => void;
  const atBoundary = new Promise<void>(resolve => { entered = resolve; });
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const wait = async () => { entered(); await pending; };
  const plugin = createPlugin({
    settings: { workerUrl: '', cloudflareDeployment: { workerName: 'crate-test', workersSubdomain: 'account' } },
    writeSettings: stage === 'connection restore' ? wait : vi.fn(async () => {}),
  });
  secretStorageHas.mockReturnValue(stage === 'connection restore');
  if (stage === 'reminders') initializeReminders.mockImplementation(wait);
  const initialize = vi.fn(stage === 'sync' ? wait : async () => {});
  const destroy = vi.fn();
  initializeSyncManagers.mockImplementation(target => {
    target.syncRuntime = { isConfigured: () => true, initialize, destroy, waitForStartupSync: async () => false };
  });
  const starting = bootstrapPlugin(plugin as never);
  await atBoundary;
  shutdownPlugin(plugin as never);
  finish();
  await starting;
  expect(registerSyncCommands).not.toHaveBeenCalled();
  expect(plugin.registerObsidianProtocolHandler).not.toHaveBeenCalled();
  expect(ensureReminderNotificationPolicy).not.toHaveBeenCalled();
  expect(initialize).toHaveBeenCalledTimes(stage === 'sync' ? 1 : 0);
  expect(destroy).toHaveBeenCalledTimes(stage === 'connection restore' ? 0 : 1);
});

it('does not let an old startup attempt resume after the same plugin starts again', async () => {
  const { bootstrapPlugin, shutdownPlugin } = await loadLifecycleModule();
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const plugin = createPlugin({ loadSettings: vi.fn().mockImplementationOnce(() => pending).mockResolvedValue(undefined) });
  const initialize = vi.fn(async () => {});
  initializeSyncManagers.mockImplementation(target => {
    target.syncRuntime = { isConfigured: () => true, initialize, waitForStartupSync: async () => false };
  });
  const first = bootstrapPlugin(plugin as never);
  shutdownPlugin(plugin as never);
  await bootstrapPlugin(plugin as never);
  finish();
  await first;
  expect(initializeSyncManagers).toHaveBeenCalledOnce();
  expect(initialize).toHaveBeenCalledOnce();
  expect(registerVaultSyncEventHandlers).toHaveBeenCalledOnce();
});

it('does not reactivate after shutdown during settings load', async () => {
  const { bootstrapPlugin, shutdownPlugin } = await loadLifecycleModule();
  let finishSettings!: () => void;
  const waitingSettings = new Promise<void>(resolve => { finishSettings = resolve; });
  const plugin = createPlugin({ loadSettings: vi.fn(() => waitingSettings) });
  const initialize = vi.fn(async () => {});
  const destroy = vi.fn();
  initializeSyncManagers.mockImplementation(target => {
    target.syncRuntime = { isConfigured: () => true, initialize, destroy, waitForStartupSync: async () => false };
  });
  const starting = bootstrapPlugin(plugin as never);
  shutdownPlugin(plugin as never);
  finishSettings();
  await starting;
  await Promise.resolve();
  expect(initialize).not.toHaveBeenCalled();
});
