import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const noticeMessages: string[] = [];
const reminderIndexLoad = vi.fn(async () => {});
const reminderIndexGetAll = vi.fn(() => [{ id: 'r1' }]);
const reminderIndexRescanFile = vi.fn(async () => {});
const reminderIndexFactory = vi.fn();
const createMarkdownWriter = vi.fn();
const createStorageCompat = vi.fn();
const migrateReminderIds = vi.fn();
const reminderQueryOnNewBlock = vi.fn();
const reminderQueryOnTodayBlock = vi.fn();
const reminderQueryOnUpcomingBlock = vi.fn();
const createRemindersBlockExtension = vi.fn(() => 'extension');
const registerReminderCommands = vi.fn();
const notificationReconcile = vi.fn(async () => {});
const notificationOnReminderChange = vi.fn<(...args: unknown[]) => Promise<{ success: boolean; error?: string }>>(
	async () => ({ success: true }),
);
const openFullScreenReminderModal = vi.fn();
const loadRemindersSettings = vi.fn();

let latestWriter: {
	setOnFileWritten: ReturnType<typeof vi.fn>;
	setOnReminderChange: ReturnType<typeof vi.fn>;
	onFileWritten?: (file: unknown) => Promise<void>;
	onReminderChange?: (reminder: unknown, operation: unknown) => Promise<unknown>;
};
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
		Notice: class Notice {
			constructor(message?: string) {
				if (message) {
					noticeMessages.push(message);
				}
			}
		},
	}));
	vi.doMock('./data/reminderIndex', () => ({
		createReminderIndex: reminderIndexFactory,
	}));
	vi.doMock('./data/reminderIdMigration', () => ({
		migrateReminderIds,
	}));
	vi.doMock('./data/markdownWriter', () => ({
		createMarkdownWriter,
	}));
	vi.doMock('./data/storageCompat', () => ({
		createStorageCompat,
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
	vi.doMock('./ui/modals', () => ({
		openFullScreenReminderModal,
	}));
	vi.doMock('./ui/reminders-view', () => ({
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
	vi.doMock('./settings-storage', () => ({
		loadRemindersSettings,
	}));

	return import('./plugin-integration');
}

function createPlugin(overrides: Record<string, unknown> = {}): Record<string, unknown> & {
	getLayoutReadyHandler: () => (() => void) | undefined;
} {
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
	createStorageCompat.mockReset();
	migrateReminderIds.mockReset();
	reminderQueryOnNewBlock.mockReset();
	reminderQueryOnTodayBlock.mockReset();
	reminderQueryOnUpcomingBlock.mockReset();
	createRemindersBlockExtension.mockReset();
	registerReminderCommands.mockReset();
	notificationReconcile.mockReset();
	notificationOnReminderChange.mockReset();
	openFullScreenReminderModal.mockReset();
	loadRemindersSettings.mockReset();

	latestWriter = {
		setOnFileWritten: vi.fn((callback) => {
			latestWriter.onFileWritten = callback;
		}),
		setOnReminderChange: vi.fn((callback) => {
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
	createStorageCompat.mockReturnValue({
		getProjects: vi.fn(() => ['Inbox', 'Work']),
	});
	migrateReminderIds.mockResolvedValue({ remindersUpdated: 0 });
	createRemindersBlockExtension.mockReturnValue('extension');
	loadRemindersSettings.mockImplementation(async (plugin) => {
		plugin.remindersSettings = {
			debugLogging: false,
			remindersFolderPath: 'Reminders',
			autoOpenView: 'sidebar',
		};
	});
});

afterEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.doUnmock('obsidian');
	vi.doUnmock('./data/reminderIndex');
	vi.doUnmock('./data/reminderIdMigration');
	vi.doUnmock('./data/markdownWriter');
	vi.doUnmock('./data/storageCompat');
	vi.doUnmock('./query/injector');
	vi.doUnmock('./query/remindersBlockLivePreview');
	vi.doUnmock('./commands');
	vi.doUnmock('./services/notificationService');
	vi.doUnmock('./services/vaultWatcher');
	vi.doUnmock('./ui/modals');
	vi.doUnmock('./ui/reminders-view');
	vi.doUnmock('./utils/logger');
	vi.doUnmock('./settings-storage');
});

describe('initializeReminders', () => {
	it('registers reminder integrations and wires backend callbacks', async () => {
		const { initializeReminders } = await loadPluginIntegrationModule();
		const plugin = createPlugin();

		await initializeReminders(plugin as never);

		expect(loadRemindersSettings).toHaveBeenCalledWith(plugin);
		expect(reminderIndexFactory).toHaveBeenCalledWith(plugin.app, 'Reminders');
		expect(reminderIndexLoad).toHaveBeenCalledTimes(1);
		expect(createMarkdownWriter).toHaveBeenCalledWith(plugin.app, (plugin as any).reminderIndex);
		expect(createStorageCompat).toHaveBeenCalledWith((plugin as any).reminderIndex, latestWriter);
		expect(notificationReconcile).toHaveBeenCalledWith([{ id: 'r1' }]);
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
		expect(latestWatcher.register).toHaveBeenCalledTimes(1);
	});
});
