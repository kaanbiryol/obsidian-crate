import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RemindersSettingsStub = {
	debugLogging: boolean;
	remindersFolderPath: string;
	autoOpenView: 'sidebar' | 'fullscreen' | 'none';
};

type FileWrittenCallback = (file: unknown) => Promise<void>;
type ReminderChangeCallback = (reminder: unknown, operation: unknown) => Promise<unknown>;
type MockWriter = {
	setOnFileWritten: ReturnType<typeof vi.fn<(callback: FileWrittenCallback) => void>>;
	setOnReminderChange: ReturnType<typeof vi.fn<(callback: ReminderChangeCallback) => void>>;
	onFileWritten?: FileWrittenCallback;
	onReminderChange?: ReminderChangeCallback;
};

type MockPlugin = {
	app: {
		workspace: {
			layoutReady: boolean;
			onLayoutReady: ReturnType<typeof vi.fn<(callback: () => void) => void>>;
		};
	};
	settings: {
		workerUrl: string;
	};
	remindersSettings: RemindersSettingsStub;
	syncRuntime: {
		getApiClient: ReturnType<typeof vi.fn>;
	};
	activateRemindersView: ReturnType<typeof vi.fn<() => Promise<void>>>;
	registerMarkdownCodeBlockProcessor: ReturnType<typeof vi.fn>;
	registerEditorExtension: ReturnType<typeof vi.fn>;
	registerView: ReturnType<typeof vi.fn>;
	addRibbonIcon: ReturnType<typeof vi.fn>;
	addCommand: ReturnType<typeof vi.fn>;
	reminderIndex?: unknown;
	markdownWriter?: unknown;
	reminderRepository?: unknown;
	remindersVaultWatcher?: {
		register?: ReturnType<typeof vi.fn>;
		unregister: ReturnType<typeof vi.fn>;
	};
	getLayoutReadyHandler: () => (() => void) | undefined;
};

const noticeMessages: string[] = [];
const reminderIndexLoad = vi.fn(async () => {});
const reminderIndexGetAll = vi.fn(() => [{ id: 'r1' }]);
const reminderIndexRescanFile = vi.fn(async () => {});
const reminderIndexFactory = vi.fn();
const createMarkdownWriter = vi.fn();
const createReminderRepository = vi.fn();
const reminderQueryOnNewBlock = vi.fn();
const reminderQueryOnTodayBlock = vi.fn();
const reminderQueryOnUpcomingBlock = vi.fn();
const createRemindersBlockExtension = vi.fn(() => 'extension');
const registerReminderCommands = vi.fn();
const notificationReconcile = vi.fn(async () => {});
const notificationCancelAll = vi.fn(async () => {});
const notificationOnReminderChange = vi.fn<(...args: unknown[]) => Promise<{ success: boolean; error?: string }>>(
	async () => ({ success: true }),
);
const openFullScreenReminderModal = vi.fn();

let latestWriter: MockWriter;
let latestWatcher: {
	register: ReturnType<typeof vi.fn>;
	unregister: ReturnType<typeof vi.fn>;
};

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function loadPluginIntegrationModule() {
	vi.doMock('obsidian', () => ({
		normalizePath: (path: string) => path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
		Notice: class Notice {
			constructor(message?: string) {
				if (message) {
					noticeMessages.push(message);
				}
			}
		},
	}));
	vi.doMock('./data/reminder-index', () => ({
		createReminderIndex: reminderIndexFactory,
	}));
	vi.doMock('./data/markdown-writer', () => ({
		createMarkdownWriter,
	}));
	vi.doMock('./data/reminder-repository', () => ({
		createReminderRepository,
	}));
	vi.doMock('./query/injector', () => ({
		ReminderQueryInjector: class ReminderQueryInjector {
			onNewBlock = reminderQueryOnNewBlock;
			onTodayBlock = reminderQueryOnTodayBlock;
			onUpcomingBlock = reminderQueryOnUpcomingBlock;
		},
	}));
	vi.doMock('./query/remindersBlockLivePreview', () => ({
		createRemindersBlockExtension,
	}));
	vi.doMock('./commands', () => ({
		registerReminderCommands,
	}));
	vi.doMock('./services/notificationService', () => ({
		ReminderNotificationService: class ReminderNotificationService {
			reconcile = notificationReconcile;
			cancelAll = notificationCancelAll;
			onReminderChange = notificationOnReminderChange;
		},
	}));
	vi.doMock('./services/vaultWatcher', () => ({
		VaultWatcher: class VaultWatcher {
			register = latestWatcher.register;
			unregister = latestWatcher.unregister;
			constructor(public readonly plugin: unknown, public readonly reminderIndex: unknown) {}
		},
	}));
	vi.doMock('./ui/adapters/modals', () => ({
		openFullScreenReminderModal,
	}));
	vi.doMock('./ui/adapters/reminders-view', () => ({
		RemindersView: class RemindersView {
			constructor(public readonly leaf: unknown, public readonly plugin: unknown) {}
		},
		VIEW_TYPE_REMINDERS: 'reminders-view',
	}));
	vi.doMock('./utils/logger', () => ({
		configureLogger: vi.fn(),
		createLogger: vi.fn(() => ({
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		})),
	}));
	return import('./plugin-integration');
}

function createPlugin(overrides: Partial<MockPlugin> = {}): MockPlugin {
	let layoutReadyHandler: (() => void) | undefined;

	return {
		app: {
			workspace: {
				layoutReady: false,
				onLayoutReady: vi.fn((callback: () => void) => {
					layoutReadyHandler = callback;
				}),
			},
		},
		settings: {
			workerUrl: 'https://worker.example',
		},
		remindersSettings: {
			debugLogging: false,
			remindersFolderPath: 'Reminders',
			autoOpenView: 'sidebar',
		},
		syncRuntime: {
			getApiClient: vi.fn(),
		},
		activateRemindersView: vi.fn(async () => {}),
		registerMarkdownCodeBlockProcessor: vi.fn(),
		registerEditorExtension: vi.fn(),
		registerView: vi.fn(),
		addRibbonIcon: vi.fn(),
		addCommand: vi.fn(),
		...overrides,
		getLayoutReadyHandler: () => layoutReadyHandler,
	};
}

beforeEach(() => {
	noticeMessages.length = 0;
	reminderIndexLoad.mockReset();
	reminderIndexGetAll.mockReset();
	reminderIndexRescanFile.mockReset();
	reminderIndexFactory.mockReset();
	createMarkdownWriter.mockReset();
	createReminderRepository.mockReset();
	reminderQueryOnNewBlock.mockReset();
	reminderQueryOnTodayBlock.mockReset();
	reminderQueryOnUpcomingBlock.mockReset();
	createRemindersBlockExtension.mockReset();
	registerReminderCommands.mockReset();
	notificationReconcile.mockReset();
	notificationCancelAll.mockReset();
	notificationOnReminderChange.mockReset();
	openFullScreenReminderModal.mockReset();

	latestWriter = {
		setOnFileWritten: vi.fn((callback: FileWrittenCallback) => {
			latestWriter.onFileWritten = callback;
		}),
		setOnReminderChange: vi.fn((callback: ReminderChangeCallback) => {
			latestWriter.onReminderChange = callback;
		}),
	};
	latestWatcher = {
		register: vi.fn(),
		unregister: vi.fn(),
	};

	reminderIndexFactory.mockImplementation(() => ({
		load: reminderIndexLoad,
		getAll: reminderIndexGetAll,
		rescanFile: reminderIndexRescanFile,
	}));
	createMarkdownWriter.mockImplementation(() => latestWriter);
	createReminderRepository.mockReturnValue({
		getProjects: vi.fn(() => ['Inbox', 'Work']),
	});
	createRemindersBlockExtension.mockReturnValue('extension');
});

afterEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.doUnmock('obsidian');
	vi.doUnmock('./data/reminder-index');
	vi.doUnmock('./data/markdown-writer');
	vi.doUnmock('./data/reminder-repository');
	vi.doUnmock('./query/injector');
	vi.doUnmock('./query/remindersBlockLivePreview');
	vi.doUnmock('./commands');
	vi.doUnmock('./services/notificationService');
	vi.doUnmock('./services/vaultWatcher');
	vi.doUnmock('./ui/adapters/modals');
	vi.doUnmock('./ui/adapters/reminders-view');
	vi.doUnmock('./utils/logger');
});

describe('initializeReminders', () => {
	it('registers reminder integrations and wires backend callbacks', async () => {
		const { initializeReminders } = await loadPluginIntegrationModule();
		const plugin = createPlugin();

		await initializeReminders(plugin as never);

		expect(reminderIndexFactory).toHaveBeenCalledWith(plugin.app, 'Reminders');
		expect(reminderIndexLoad).toHaveBeenCalledTimes(1);
		expect(createMarkdownWriter).toHaveBeenCalledWith(plugin.app, plugin.reminderIndex);
		expect(createReminderRepository).toHaveBeenCalledWith(plugin.reminderIndex, latestWriter);
		expect(notificationReconcile).not.toHaveBeenCalled();
		expect(latestWatcher.register).toHaveBeenCalledTimes(1);
		expect(plugin.registerMarkdownCodeBlockProcessor).toHaveBeenCalledTimes(4);
		expect(plugin.registerEditorExtension).toHaveBeenCalledWith('extension');
		expect(plugin.registerView).toHaveBeenCalledWith('reminders-view', expect.any(Function));
		expect(plugin.addRibbonIcon).toHaveBeenCalledWith('check-circle', 'Open reminders', expect.any(Function));
		expect(registerReminderCommands).toHaveBeenCalledWith(plugin);
		expect(plugin.addCommand).toHaveBeenCalledWith(expect.objectContaining({
			id: 'open-reminders-view',
			name: 'Open reminders sidebar',
		}));
		expect(plugin.addCommand).toHaveBeenCalledWith(expect.objectContaining({
			id: 'open-reminders-fullscreen',
			name: 'Open reminders full screen',
		}));

		const layoutReadyHandler = plugin.getLayoutReadyHandler();
		expect(layoutReadyHandler).toEqual(expect.any(Function));
		layoutReadyHandler?.();
		await flushMicrotasks();
		expect(plugin.activateRemindersView).toHaveBeenCalledTimes(1);

		await latestWriter.onFileWritten?.({ path: 'Reminders/Work.md' });
		expect(reminderIndexRescanFile).toHaveBeenCalledWith({ path: 'Reminders/Work.md' }, true);

		notificationOnReminderChange.mockResolvedValueOnce({ success: false, error: 'push failed' });
		const changeResult = await latestWriter.onReminderChange?.({ id: 'r1' }, 'update');
		expect(changeResult).toEqual({ success: false, error: 'push failed' });
		expect(noticeMessages).toContain('Reminder saved but notification sync failed:\npush failed');
	});

	it('does not duplicate UI registration when reminders are initialized twice for the same plugin', async () => {
		const { initializeReminders } = await loadPluginIntegrationModule();
		const plugin = createPlugin();

		await initializeReminders(plugin as never);
		await initializeReminders(plugin as never);

		expect(plugin.registerMarkdownCodeBlockProcessor).toHaveBeenCalledTimes(4);
		expect(plugin.registerView).toHaveBeenCalledTimes(1);
		expect(plugin.addRibbonIcon).toHaveBeenCalledTimes(1);
		expect(plugin.addCommand).toHaveBeenCalledTimes(2);
		expect(registerReminderCommands).toHaveBeenCalledTimes(1);
		expect(reminderIndexFactory).toHaveBeenCalledTimes(2);
		expect(latestWatcher.register).toHaveBeenCalledTimes(2);
	});
});

describe('reinitializeReminders', () => {
	it('normalizes the folder path and rebuilds the reminder backend', async () => {
		const { reinitializeReminders } = await loadPluginIntegrationModule();
		const oldWatcher = { unregister: vi.fn() };
		const plugin = createPlugin({
			remindersVaultWatcher: oldWatcher,
		});

		await reinitializeReminders(plugin as never, ' Reminders/Work/ ');

		expect(oldWatcher.unregister).toHaveBeenCalledTimes(1);
		expect(reminderIndexFactory).toHaveBeenCalledWith(plugin.app, 'Reminders/Work');
		expect(notificationReconcile).toHaveBeenCalledWith([{ id: 'r1' }]);
		expect(latestWatcher.register).toHaveBeenCalledTimes(1);
	});
});

describe('notification lifecycle', () => {
	it('cancels after in-flight reconciliation and suppresses new reconciliation until enabled', async () => {
		const {
			disableReminderNotifications,
			enableReminderNotifications,
			reconcileReminderNotifications,
		} = await loadPluginIntegrationModule();
		let finishReconcile!: () => void;
		const inFlightReconcile = new Promise<void>((resolve) => {
			finishReconcile = resolve;
		});
		notificationReconcile.mockImplementationOnce(() => inFlightReconcile);
		const plugin = createPlugin({
			reminderIndex: { getAll: vi.fn(() => []) },
		});

		const initialReconcile = reconcileReminderNotifications(plugin as never);
		await vi.waitFor(() => {
			expect(notificationReconcile).toHaveBeenCalledTimes(1);
		});
		const disable = disableReminderNotifications(plugin as never);
		const suppressedReconcile = reconcileReminderNotifications(plugin as never);

		expect(notificationCancelAll).not.toHaveBeenCalled();
		finishReconcile();
		await Promise.all([initialReconcile, disable, suppressedReconcile]);

		expect(notificationCancelAll).toHaveBeenCalledTimes(1);
		expect(notificationReconcile).toHaveBeenCalledTimes(1);

		await enableReminderNotifications(plugin as never);
		expect(notificationReconcile).toHaveBeenCalledTimes(2);
	});
});
