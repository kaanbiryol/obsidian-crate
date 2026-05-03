import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const noticeMessages: Array<string | object> = [];
type ProtocolHandler = (params: Record<string, string>) => void;
type SyncRuntimeTarget = {
	syncRuntime?: {
		isConfigured: () => boolean;
		initialize: () => Promise<void>;
	};
};

const initializeReminders = vi.fn();
const handleSyncSetupProtocol = vi.fn();
const initializeSyncManagers = vi.fn<(target: SyncRuntimeTarget) => void>();
const registerSyncCommands = vi.fn();
const registerVaultSyncEventHandlers = vi.fn();
const ensurePluginDeviceId = vi.fn();
const openFullScreenReminderModal = vi.fn();

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
		},
	}));
	vi.doMock('./logger', () => ({
		createLogger: vi.fn(() => ({
			info: vi.fn(),
			error: vi.fn(),
		})),
		errorMessage: vi.fn((error: unknown) => String(error)),
	}));
	vi.doMock('../ui/settings-tab', () => ({
		CrateSettingTab: class CrateSettingTab {
			constructor(public readonly app: unknown, public readonly plugin: unknown) {}
		},
	}));
	vi.doMock('../reminders/ui/modals', () => ({
		openFullScreenReminderModal,
	}));
	vi.doMock('../reminders/plugin-integration', () => ({
		initializeReminders,
	}));
	vi.doMock('../sync/plugin-integration', () => ({
		handleSyncSetupProtocol,
		initializeSyncManagers,
		registerSyncCommands,
		registerVaultSyncEventHandlers,
	}));
	vi.doMock('./deviceId', () => ({
		ensurePluginDeviceId,
	}));

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
			id: 'obsidian-crate',
		},
		loadSettings: vi.fn(async () => {}),
		addSettingTab: vi.fn(),
		registerObsidianProtocolHandler: vi.fn(),
		...overrides,
	};
}

beforeEach(() => {
	noticeMessages.length = 0;
	initializeReminders.mockReset();
	handleSyncSetupProtocol.mockReset();
	initializeSyncManagers.mockReset();
	registerSyncCommands.mockReset();
	registerVaultSyncEventHandlers.mockReset();
	ensurePluginDeviceId.mockReset();
	openFullScreenReminderModal.mockReset();
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
	vi.doUnmock('../reminders/ui/modals');
	vi.doUnmock('../reminders/plugin-integration');
	vi.doUnmock('../sync/plugin-integration');
	vi.doUnmock('./deviceId');
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
			};
		});

		await bootstrapPlugin(plugin as never);

		expect(plugin.loadSettings).toHaveBeenCalledTimes(1);
		expect(ensurePluginDeviceId).toHaveBeenCalledWith(plugin);
		expect(plugin.addSettingTab).toHaveBeenCalledTimes(1);
		expect(registerVaultSyncEventHandlers).toHaveBeenCalledWith(plugin);
		expect(syncInitialize).toHaveBeenCalledTimes(1);
		expect(registerSyncCommands).toHaveBeenCalledWith(plugin);
		expect(initializeReminders).toHaveBeenCalledWith(plugin);
		expect(plugin.registerObsidianProtocolHandler).toHaveBeenCalledTimes(2);

		const setupHandler = plugin.registerObsidianProtocolHandler.mock.calls.find(
			([name]) => name === 'crate-setup',
		)?.[1] as ProtocolHandler | undefined;
		const remindersHandler = plugin.registerObsidianProtocolHandler.mock.calls.find(
			([name]) => name === 'crate-reminders',
		)?.[1] as ProtocolHandler | undefined;

		expect(typeof setupHandler).toBe('function');
		expect(typeof remindersHandler).toBe('function');

		setupHandler?.({ workerUrl: 'https://worker.example', authToken: 'token' });
		remindersHandler?.({ project: 'Work' });

		expect(handleSyncSetupProtocol).toHaveBeenCalledWith(plugin, {
			workerUrl: 'https://worker.example',
			authToken: 'token',
		});
		expect(openFullScreenReminderModal).toHaveBeenCalledWith(plugin, 'Work');
	});

	it('shows the setup notice instead of starting sync when the plugin is not configured', async () => {
		const { bootstrapPlugin } = await loadLifecycleModule();
		const syncInitialize = vi.fn(async () => {});
		const plugin = createPlugin();

		initializeSyncManagers.mockImplementation((target) => {
			target.syncRuntime = {
				isConfigured: vi.fn(() => false),
				initialize: syncInitialize,
			};
		});

		await bootstrapPlugin(plugin as never);

		expect(syncInitialize).not.toHaveBeenCalled();
		expect(initializeReminders).toHaveBeenCalledWith(plugin);
		expect(noticeMessages).toHaveLength(1);
		expect(noticeMessages[0]).toBeInstanceOf(FakeDocumentFragment);
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
		expect(plugin.addSettingTab).not.toHaveBeenCalled();
		expect(registerVaultSyncEventHandlers).not.toHaveBeenCalled();
		expect(registerSyncCommands).not.toHaveBeenCalled();
		expect(initializeReminders).not.toHaveBeenCalled();
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
			remindersVaultWatcher: { unregister },
		} as never);

		expect(destroy).toHaveBeenCalledTimes(1);
		expect(unregister).toHaveBeenCalledTimes(1);
	});
});
