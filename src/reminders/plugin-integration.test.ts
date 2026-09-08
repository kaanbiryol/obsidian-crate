import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RemindersSettingsStub = {
	remindersFolderPath: string;
	autoOpenView: 'sidebar' | 'none';
};

type FileWrittenCallback = (file: unknown) => Promise<void>;
type MockWriter = {
	setOnFileWritten: ReturnType<typeof vi.fn<(callback: FileWrittenCallback) => void>>;
	onFileWritten?: FileWrittenCallback;
};

type MockPlugin = {
	manifest: { dir: string };
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
		isConfigured: ReturnType<typeof vi.fn>;
		getState: ReturnType<typeof vi.fn>;
		addStateChangeListener: ReturnType<typeof vi.fn>;
		removeStateChangeListener: ReturnType<typeof vi.fn>;
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

const reminderIndexLoad = vi.fn(async () => {});
const reminderIndexGetAll = vi.fn(() => [{ id: 'r1' }]);
const reminderIndexRescanFile = vi.fn(async () => {});
const reminderIndexFlushDeferredScans = vi.fn(async () => {});
const reminderIndexFactory = vi.fn();
const createMarkdownWriter = vi.fn();
const createReminderRepository = vi.fn();
const reminderQueryOnNewBlock = vi.fn();
const reminderQueryOnTodayBlock = vi.fn();
const reminderQueryOnUpcomingBlock = vi.fn();
const createRemindersBlockExtension = vi.fn(() => 'extension');
const registerReminderCommands = vi.fn();
const recoverMoves = vi.fn(async (): Promise<string[]> => []);
const pendingMoves = vi.fn(() => false);
const pendingMoveFile = vi.fn(() => false);
const moveJournal = { recover: recoverMoves, hasPending: pendingMoves, isPendingFile: pendingMoveFile,
	assertActive: vi.fn(), assertWritable: vi.fn(), execute: vi.fn() };
const createMoveJournal = vi.fn(() => moveJournal);

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
		Notice: class {},
	}));
	vi.doMock('./data/reminder-move-journal', () => ({ createReminderMoveJournal: createMoveJournal }));
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
	vi.doMock('./services/vaultWatcher', () => ({
		VaultWatcher: class VaultWatcher {
			register = latestWatcher.register;
			unregister = latestWatcher.unregister;
			constructor(public readonly plugin: unknown, public readonly reminderIndex: unknown) {}
		},
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
		manifest: { dir: '.obsidian/plugins/crate' },
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
			remindersFolderPath: 'Reminders',
			autoOpenView: 'sidebar',
		},
		syncRuntime: {
			getApiClient: vi.fn(),
			isConfigured: vi.fn(() => false),
			getState: vi.fn(() => ({ status: 'idle' })),
			addStateChangeListener: vi.fn(),
			removeStateChangeListener: vi.fn(),
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
	recoverMoves.mockReset().mockResolvedValue([]);
	pendingMoves.mockReset().mockReturnValue(false);
	pendingMoveFile.mockReset().mockReturnValue(false);
	createMoveJournal.mockClear();
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

	latestWriter = {
		setOnFileWritten: vi.fn((callback: FileWrittenCallback) => {
			latestWriter.onFileWritten = callback;
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
		flushDeferredScans: reminderIndexFlushDeferredScans,
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
	vi.doUnmock('./data/reminder-move-journal');
	vi.doUnmock('./query/injector');
	vi.doUnmock('./query/remindersBlockLivePreview');
	vi.doUnmock('./commands');
	vi.doUnmock('./services/vaultWatcher');
	vi.doUnmock('./ui/adapters/reminders-view');
	vi.doUnmock('./utils/logger');
});

describe('initializeReminders', () => {
	it('registers reminder integrations and wires backend callbacks', async () => {
		const { initializeReminders } = await loadPluginIntegrationModule();
		const plugin = createPlugin();

		await initializeReminders(plugin as never);

		expect(reminderIndexFactory).toHaveBeenCalledWith(plugin.app, 'Reminders', expect.any(AbortSignal), expect.any(Function), expect.any(Function));
		expect(reminderIndexLoad).toHaveBeenCalledTimes(1);
		expect(createMarkdownWriter).toHaveBeenCalledWith(plugin.app, plugin.reminderIndex, moveJournal);
		expect(createReminderRepository).toHaveBeenCalledWith(plugin.reminderIndex, latestWriter);
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
		expect(plugin.addCommand).not.toHaveBeenCalledWith(expect.objectContaining({
			id: 'open-reminders-fullscreen',
		}));

		const layoutReadyHandler = plugin.getLayoutReadyHandler();
		expect(layoutReadyHandler).toEqual(expect.any(Function));
		layoutReadyHandler?.();
		await flushMicrotasks();
		expect(plugin.activateRemindersView).toHaveBeenCalledTimes(1);

		await latestWriter.onFileWritten?.({ path: 'Reminders/Work.md' });
		expect(reminderIndexRescanFile).toHaveBeenCalledWith({ path: 'Reminders/Work.md' }, true);
	});

	it('does not duplicate UI registration when reminders are initialized twice for the same plugin', async () => {
		const { initializeReminders } = await loadPluginIntegrationModule();
		const plugin = createPlugin();

		await initializeReminders(plugin as never);
		await initializeReminders(plugin as never);

		expect(plugin.registerMarkdownCodeBlockProcessor).toHaveBeenCalledTimes(4);
		expect(plugin.registerView).toHaveBeenCalledTimes(1);
		expect(plugin.addRibbonIcon).toHaveBeenCalledTimes(1);
		expect(plugin.addCommand).toHaveBeenCalledTimes(1);
		expect(registerReminderCommands).toHaveBeenCalledTimes(1);
		expect(reminderIndexFactory).toHaveBeenCalledTimes(2);
		expect(latestWatcher.register).toHaveBeenCalledTimes(2);
	});
	it('waits for automatic sidebar activation when layout is already ready', async () => {
		const { initializeReminders } = await loadPluginIntegrationModule();
		const plugin = createPlugin();
		let finish!: () => void;
		const ready = new Promise<void>(resolve => { finish = resolve; });
		plugin.app.workspace.onLayoutReady.mockImplementation(callback => callback());
		plugin.activateRemindersView.mockReturnValue(ready);
		let initialized = false;
		const initializing = initializeReminders(plugin as never).then(() => { initialized = true; });
		await vi.waitFor(() => expect(plugin.activateRemindersView).toHaveBeenCalledOnce());
		expect(initialized).toBe(false);
		finish(); await initializing;
		expect(initialized).toBe(true);
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
		expect(reminderIndexFactory).toHaveBeenCalledWith(plugin.app, 'Reminders/Work', expect.any(AbortSignal), expect.any(Function), expect.any(Function));
		expect(latestWatcher.register).toHaveBeenCalledTimes(1);
	});
});

it('does not publish a reminder backend or register UI after shutdown during index load', async () => {
  const { initializeReminders } = await loadPluginIntegrationModule();
  let finish!: () => void;
  reminderIndexLoad.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const plugin = createPlugin();
  const starting = initializeReminders(plugin as never);
  const { endPluginLifecycle } = await import('../plugin/lifecycle-state');
  endPluginLifecycle(plugin as never);
  finish();
  await starting;
  expect(plugin.reminderIndex).toBeUndefined();
  expect(latestWatcher.register).not.toHaveBeenCalled();
  expect(createMarkdownWriter).not.toHaveBeenCalled();
  expect(plugin.registerView).not.toHaveBeenCalled();
});

it('keeps the newer folder backend when an older scan finishes last', async () => {
  const { initializeReminders, reinitializeReminders } = await loadPluginIntegrationModule();
  let finish!: () => void;
  let entered!: () => void;
  const loading = new Promise<void>(resolve => { entered = resolve; });
  reminderIndexLoad.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; entered(); }));
  const plugin = createPlugin();
  const first = initializeReminders(plugin as never);
  await loading;
  await reinitializeReminders(plugin as never, 'NewFolder');
  const current = plugin.reminderIndex;
  finish();
  await first;
  expect(plugin.reminderIndex).toBe(current);
  expect(latestWatcher.register).toHaveBeenCalledOnce();
  expect(plugin.registerView).toHaveBeenCalledOnce();
  expect(registerReminderCommands).toHaveBeenCalledOnce();
  expect((reminderIndexFactory.mock.calls[0]?.[2] as AbortSignal).aborted).toBe(true);
});

it('does not auto-open the view after unloading before layout is ready', async () => {
  const { initializeReminders } = await loadPluginIntegrationModule();
  const plugin = createPlugin();
  await initializeReminders(plugin as never);
  const { endPluginLifecycle } = await import('../plugin/lifecycle-state');
  endPluginLifecycle(plugin as never);
  plugin.getLayoutReadyHandler()?.();
  expect(plugin.activateRemindersView).not.toHaveBeenCalled();
});

it('flushes deferred scans on sync state changes and removes the listener on unload', async () => {
	const { initializeReminders } = await loadPluginIntegrationModule();
	const plugin = createPlugin();
	await initializeReminders(plugin as never);
	const listener = plugin.syncRuntime.addStateChangeListener.mock.calls[0]?.[0] as (() => void) | undefined;
	expect(listener).toBeDefined();
	listener?.();
	await flushMicrotasks();
	expect(reminderIndexFlushDeferredScans).toHaveBeenCalledOnce();
	const { endPluginLifecycle } = await import('../plugin/lifecycle-state');
	endPluginLifecycle(plugin as never);
	expect(plugin.syncRuntime.removeStateChangeListener).toHaveBeenCalledWith(listener);
});

it('defers startup collision repair until the configured connection finishes a successful sync', async () => {
	const { initializeReminders } = await loadPluginIntegrationModule();
	const plugin = createPlugin();
	plugin.syncRuntime.isConfigured.mockReturnValue(true);
	await initializeReminders(plugin as never);
	const shouldDefer = reminderIndexFactory.mock.calls[0]?.[4] as () => boolean;
	const listener = plugin.syncRuntime.addStateChangeListener.mock.calls[0]?.[0] as () => void;
	expect(shouldDefer()).toBe(true);
	plugin.syncRuntime.getApiClient.mockReturnValue({});
	listener(); // An idle initialization callback has not reconciled file ownership.
	expect(shouldDefer()).toBe(true);
	for (const status of ['syncing', 'error', 'idle']) {
		plugin.syncRuntime.getState.mockReturnValue({ status });
		listener();
	}
	expect(shouldDefer()).toBe(true);
	for (const status of ['syncing', 'idle']) {
		plugin.syncRuntime.getState.mockReturnValue({ status });
		listener();
	}
	expect(shouldDefer()).toBe(false);
	plugin.syncRuntime.getApiClient.mockReturnValue({});
	expect(shouldDefer()).toBe(true); // A replaced connection needs its own reconciliation.
});

it('recovers interrupted moves before scanning and protects unresolved file paths from normalization', async () => {
	const { initializeReminders } = await loadPluginIntegrationModule();
	const plugin = createPlugin();
	pendingMoves.mockReturnValue(true);
	pendingMoveFile.mockImplementation((...args: unknown[]) => args[0] === 'Reminders/Pending.md');
	recoverMoves.mockResolvedValueOnce(['Review both copies before retrying recovery.']);
	await initializeReminders(plugin as never);
	expect(recoverMoves.mock.invocationCallOrder[0]).toBeLessThan(reminderIndexLoad.mock.invocationCallOrder[0]!);
	const defer = reminderIndexFactory.mock.calls[0]?.[3] as (path?: string) => boolean;
	expect(defer()).toBe(false);
	expect(defer('Reminders/Healthy.md')).toBe(false);
	expect(defer('Reminders/Pending.md')).toBe(true);
	const { recoverInterruptedReminderMoves } = await import('./runtime');
	pendingMoves.mockReturnValue(false);
	await recoverInterruptedReminderMoves(plugin as never);
	expect(recoverMoves).toHaveBeenCalledTimes(2);
	expect(reminderIndexLoad).toHaveBeenCalledTimes(2);
});

it('does not start normalization when unloaded during journal recovery', async () => {
	const { initializeReminders } = await loadPluginIntegrationModule();
	let finish!: (issues: string[]) => void;
	recoverMoves.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
	const plugin = createPlugin();
	const starting = initializeReminders(plugin as never);
	const { endPluginLifecycle } = await import('../plugin/lifecycle-state');
	endPluginLifecycle(plugin as never);
	finish([]);
	await starting;
	expect(reminderIndexFactory).not.toHaveBeenCalled();
	expect(createMarkdownWriter).not.toHaveBeenCalled();
	expect(plugin.reminderIndex).toBeUndefined();
});
