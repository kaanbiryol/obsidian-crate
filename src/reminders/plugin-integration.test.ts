import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReminderIndexOptions } from './data/reminder-index';

type RemindersSettingsStub = {
	enabled: boolean;
	remindersFolderPath: string;
	autoOpenView: 'sidebar' | 'none';
};

type MockPlugin = {
	manifest: { dir: string };
	app: {
		workspace: {
			layoutReady: boolean;
			onLayoutReady: ReturnType<typeof vi.fn<(callback: () => void) => void>>;
			detachLeavesOfType: ReturnType<typeof vi.fn>;
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
	writeRemindersSettings: ReturnType<typeof vi.fn<(update: Partial<RemindersSettingsStub>) => Promise<void>>>;
	registerMarkdownCodeBlockProcessor: ReturnType<typeof vi.fn>;
	registerView: ReturnType<typeof vi.fn>;
	addRibbonIcon: ReturnType<typeof vi.fn>;
	addCommand: ReturnType<typeof vi.fn>;
	reminders?: {
		index?: unknown;
		repository?: unknown;
		watcher: {
			register?: ReturnType<typeof vi.fn>;
			unregister: ReturnType<typeof vi.fn>;
		};
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
const reminderQueryOnBlock = vi.fn();
const registerReminderCommands = vi.fn();
const recoverMoves = vi.fn(async (): Promise<string[]> => []);
const notices = vi.fn();
const pendingMoves = vi.fn(() => false);
const pendingMoveFile = vi.fn(() => false);
const moveJournal = { recover: recoverMoves, hasPending: pendingMoves, isPendingFile: pendingMoveFile,
	assertActive: vi.fn(), assertWritable: vi.fn(), execute: vi.fn() };
const createMoveJournal = vi.fn(() => moveJournal);
const activateOrRevealRemindersLeaf = vi.fn(async (..._args: unknown[]) => {});

const latestWriter = {};
let latestWatcher: {
	register: ReturnType<typeof vi.fn>;
	unregister: ReturnType<typeof vi.fn>;
};

function indexOptions(call = 0): ReminderIndexOptions {
	return reminderIndexFactory.mock.calls[call]?.[2] as ReminderIndexOptions;
}

const gatedIndexOptions: Record<keyof ReminderIndexOptions, unknown> = {
	signal: expect.any(AbortSignal),
	shouldDeferScan: expect.any(Function),
	shouldDeferCollisionRepair: expect.any(Function),
};

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function loadPluginIntegrationModule() {
	vi.doMock('obsidian', () => ({
		addIcon: vi.fn(),
		normalizePath: (path: string) => path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
		Notice: class { constructor(message: unknown) { notices(message); } },
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
			onBlock = reminderQueryOnBlock;
		},
	}));
	vi.doMock('./commands', () => ({
		registerReminderCommands,
	}));
	vi.doMock('./data/vault-watcher', () => ({
		VaultWatcher: class VaultWatcher {
			register = latestWatcher.register;
			unregister = latestWatcher.unregister;
			constructor(public readonly plugin: unknown, public readonly reminderIndex: unknown) {}
		},
	}));
	vi.doMock('./ui/plugin/workspaceLayout', () => ({ activateOrRevealRemindersLeaf }));
	vi.doMock('./ui/plugin/reminders-view', () => ({
		RemindersView: class RemindersView {
			constructor(public readonly leaf: unknown, public readonly plugin: unknown) {}
		},
		VIEW_TYPE_REMINDERS: 'reminders-view',
	}));
	vi.doMock('./logger', () => ({
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

	const plugin: MockPlugin = {
		manifest: { dir: '.obsidian/plugins/crate' },
		app: {
			workspace: {
				layoutReady: false,
				onLayoutReady: vi.fn((callback: () => void) => {
					layoutReadyHandler = callback;
				}),
				detachLeavesOfType: vi.fn(),
			},
		},
		settings: {
			workerUrl: 'https://worker.example',
		},
		remindersSettings: {
			enabled: true,
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
		writeRemindersSettings: vi.fn(async (update: Partial<RemindersSettingsStub>) => { Object.assign(plugin.remindersSettings, update); }),
		registerMarkdownCodeBlockProcessor: vi.fn(),
		registerView: vi.fn(),
		addRibbonIcon: vi.fn(),
		addCommand: vi.fn(),
		...overrides,
		getLayoutReadyHandler: () => layoutReadyHandler,
	};
	return plugin;
}

beforeEach(() => {
	recoverMoves.mockReset().mockResolvedValue([]);
	notices.mockReset();
	pendingMoves.mockReset().mockReturnValue(false);
	pendingMoveFile.mockReset().mockReturnValue(false);
	createMoveJournal.mockClear();
	reminderIndexLoad.mockReset();
	reminderIndexGetAll.mockReset();
	reminderIndexRescanFile.mockReset();
	reminderIndexFactory.mockReset();
	activateOrRevealRemindersLeaf.mockReset().mockResolvedValue(undefined);
	createMarkdownWriter.mockReset();
	createReminderRepository.mockReset();
	reminderQueryOnBlock.mockReset();
	registerReminderCommands.mockReset();

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
	vi.doUnmock('./commands');
	vi.doUnmock('./data/vault-watcher');
	vi.doUnmock('./ui/plugin/workspaceLayout');
	vi.doUnmock('./ui/plugin/reminders-view');
	vi.doUnmock('./utils/logger');
});

describe('initializeReminders', () => {
	it('registers reminder integrations and wires backend callbacks', async () => {
		const { initializeReminders } = await loadPluginIntegrationModule();
		const plugin = createPlugin();

		await initializeReminders(plugin as never);

		expect(reminderIndexFactory).toHaveBeenCalledWith(plugin.app, 'Reminders', gatedIndexOptions);
		expect(reminderIndexLoad).toHaveBeenCalledTimes(1);
		expect(plugin.reminders?.repository).toBe(createReminderRepository.mock.results[0]?.value);
		expect(plugin.reminders?.watcher.register).toBe(latestWatcher.register);
		expect(createMarkdownWriter).toHaveBeenCalledWith(plugin.app, plugin.reminders?.index, moveJournal);
		expect(createReminderRepository).toHaveBeenCalledWith(plugin.reminders?.index, latestWriter);
		expect(latestWatcher.register).toHaveBeenCalledTimes(1);
		expect(plugin.registerMarkdownCodeBlockProcessor).toHaveBeenCalledTimes(3);
		for (const [language, processor] of plugin.registerMarkdownCodeBlockProcessor.mock.calls as Array<[string, (source: string, el: unknown, ctx: unknown) => void]>) {
			processor('source', 'el', 'ctx');
			expect(reminderQueryOnBlock).toHaveBeenLastCalledWith(language, 'source', 'el', 'ctx');
		}
		expect(plugin.registerView).toHaveBeenCalledWith('reminders-view', expect.any(Function));
		expect(plugin.addRibbonIcon).toHaveBeenCalledWith('crate-logo', 'Open Crate', expect.any(Function));
		expect(registerReminderCommands).toHaveBeenCalledWith(plugin);
		expect(plugin.addCommand).toHaveBeenCalledWith(expect.objectContaining({
			id: 'open-reminders-view',
			name: 'Open sidebar',
		}));
		expect(plugin.addCommand).not.toHaveBeenCalledWith(expect.objectContaining({
			id: 'open-reminders-fullscreen',
		}));

		const layoutReadyHandler = plugin.getLayoutReadyHandler();
		expect(layoutReadyHandler).toEqual(expect.any(Function));
		layoutReadyHandler?.();
		await flushMicrotasks();
		expect(activateOrRevealRemindersLeaf).toHaveBeenCalledExactlyOnceWith(plugin.app.workspace, 'reminders-view', undefined, expect.any(AbortSignal));
	});

	it('does not duplicate UI registration when reminders are initialized twice for the same plugin', async () => {
		const { initializeReminders } = await loadPluginIntegrationModule();
		const plugin = createPlugin();

		await initializeReminders(plugin as never);
		await initializeReminders(plugin as never);

		expect(plugin.registerMarkdownCodeBlockProcessor).toHaveBeenCalledTimes(3);
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
		activateOrRevealRemindersLeaf.mockReturnValue(ready);
		let initialized = false;
		const initializing = initializeReminders(plugin as never).then(() => { initialized = true; });
		await vi.waitFor(() => expect(activateOrRevealRemindersLeaf).toHaveBeenCalledOnce());
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
			reminders: { watcher: oldWatcher },
		});

		await reinitializeReminders(plugin as never, ' Reminders/Work/ ');

		expect(oldWatcher.unregister).toHaveBeenCalledTimes(1);
		expect(reminderIndexFactory).toHaveBeenCalledWith(plugin.app, 'Reminders/Work', gatedIndexOptions);
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
	expect(plugin.reminders).toBeUndefined();
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
	const current = plugin.reminders;
	finish();
	await first;
	expect(plugin.reminders).toBe(current);
	expect(latestWatcher.register).toHaveBeenCalledOnce();
	expect(plugin.registerView).toHaveBeenCalledOnce();
	expect(registerReminderCommands).toHaveBeenCalledOnce();
	expect(indexOptions().signal?.aborted).toBe(true);
});

it('does not auto-open the view after unloading before layout is ready', async () => {
	const { initializeReminders } = await loadPluginIntegrationModule();
	const plugin = createPlugin();
	await initializeReminders(plugin as never);
	const { endPluginLifecycle } = await import('../plugin/lifecycle-state');
	endPluginLifecycle(plugin as never);
	plugin.getLayoutReadyHandler()?.();
	expect(activateOrRevealRemindersLeaf).not.toHaveBeenCalled();
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
	const shouldDefer = indexOptions().shouldDeferCollisionRepair!;
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

it.each(['folder change', 're-enable'])('waits for a completed sync after a %s and keeps it across later rebuilds', async rebuild => {
	const { initializeReminders, reinitializeReminders, setRemindersEnabled } = await loadPluginIntegrationModule();
	const plugin = createPlugin();
	plugin.syncRuntime.isConfigured.mockReturnValue(true);
	const rebuildBackend = rebuild === 'folder change'
		? () => reinitializeReminders(plugin as never, 'Tasks')
		: async () => { await setRemindersEnabled(plugin as never, false); await setRemindersEnabled(plugin as never, true); };
	await initializeReminders(plugin as never);
	plugin.syncRuntime.getApiClient.mockReturnValue({}); // Connected, but its first sync has not finished.
	await rebuildBackend();
	const shouldDefer = () => indexOptions(reminderIndexFactory.mock.calls.length - 1).shouldDeferCollisionRepair!();
	expect(shouldDefer()).toBe(true);
	const listener = plugin.syncRuntime.addStateChangeListener.mock.lastCall?.[0] as () => void;
	for (const status of ['syncing', 'idle']) {
		plugin.syncRuntime.getState.mockReturnValue({ status });
		listener();
	}
	expect(shouldDefer()).toBe(false);
	await rebuildBackend();
	expect(shouldDefer()).toBe(false);
});

it('recovers interrupted moves before scanning and protects unresolved file paths from normalization', async () => {
	const { initializeReminders } = await loadPluginIntegrationModule();
	const plugin = createPlugin();
	pendingMoves.mockReturnValue(true);
	pendingMoveFile.mockImplementation((...args: unknown[]) => args[0] === 'Reminders/Pending.md');
	recoverMoves.mockResolvedValueOnce(['Review both copies before retrying recovery.']);
	await initializeReminders(plugin as never);
	expect(recoverMoves.mock.invocationCallOrder[0]).toBeLessThan(reminderIndexLoad.mock.invocationCallOrder[0]!);
	const defer = indexOptions().shouldDeferScan!;
	plugin.app.workspace.layoutReady = true;
	expect(defer()).toBe(false);
	expect(defer('Reminders/Healthy.md')).toBe(false);
	expect(defer('Reminders/Pending.md')).toBe(true);

});

it('reports an unresolved move once and does not rescan reminders on every sync state change', async () => {
	const { initializeReminders } = await loadPluginIntegrationModule();
	const plugin = createPlugin();
	pendingMoves.mockReturnValue(true);
	recoverMoves.mockResolvedValue(['Review both copies before retrying recovery.']);
	await initializeReminders(plugin as never);
	const listener = plugin.syncRuntime.addStateChangeListener.mock.calls[0]?.[0] as () => void;
	for (let index = 0; index < 3; index++) {
		listener();
		await flushMicrotasks();
	}
	expect(recoverMoves).toHaveBeenCalledTimes(4);
	expect(notices).toHaveBeenCalledOnce();
	expect(reminderIndexLoad).toHaveBeenCalledOnce();
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
	expect(plugin.reminders).toBeUndefined();
});

 it('defers scanning the vault until Obsidian has loaded its file list', async () => {
	const { initializeReminders } = await loadPluginIntegrationModule();
	const plugin = createPlugin();
	await initializeReminders(plugin as never);
	const defer = indexOptions().shouldDeferScan!;
	expect(defer()).toBe(true);
	expect(defer('Reminders/Inbox.md')).toBe(true);
	expect(plugin.registerView).toHaveBeenCalled();
	expect(reminderIndexFlushDeferredScans).not.toHaveBeenCalled();
	plugin.app.workspace.layoutReady = true;
	for (const [onReady] of plugin.app.workspace.onLayoutReady.mock.calls) onReady();
	await flushMicrotasks();
	expect(defer()).toBe(false);
	expect(reminderIndexFlushDeferredScans).toHaveBeenCalledOnce();
 });

 it('does not run a deferred startup scan after the backend is unloaded', async () => {
	const { initializeReminders } = await loadPluginIntegrationModule();
	const plugin = createPlugin();
	await initializeReminders(plugin as never);
	const { endPluginLifecycle } = await import('../plugin/lifecycle-state');
	endPluginLifecycle(plugin as never);
	plugin.app.workspace.layoutReady = true;
	for (const [onReady] of plugin.app.workspace.onLayoutReady.mock.calls) onReady();
	await flushMicrotasks();
	expect(reminderIndexFlushDeferredScans).not.toHaveBeenCalled();
 });

it('stops the backend signal and watcher when reminders are disabled', async () => {
	const { initializeReminders } = await loadPluginIntegrationModule();
	const { stopReminderBackend } = await import('./runtime');
	const plugin = createPlugin();
	await initializeReminders(plugin as never);
	const signal = indexOptions().signal!;
	expect(signal.aborted).toBe(false);
	stopReminderBackend(plugin as never);
	expect(signal.aborted).toBe(true);
	expect(latestWatcher.unregister).toHaveBeenCalledOnce();
	expect(plugin.reminders).toBeUndefined();
});

describe('setRemindersEnabled', () => {
	it('stops local reminders without deleting notes when disabled and restarts them when enabled', async () => {
		const { setRemindersEnabled } = await loadPluginIntegrationModule();
		const watcher = { unregister: vi.fn() };
		const plugin = createPlugin({ reminders: { watcher } });
		await setRemindersEnabled(plugin as never, false);
		expect(plugin.remindersSettings.enabled).toBe(false);
		expect(watcher.unregister).toHaveBeenCalledOnce();
		expect(plugin.reminders).toBeUndefined();
		expect(plugin.app.workspace.detachLeavesOfType).toHaveBeenCalledWith('reminders-view');
		expect(reminderIndexFactory).not.toHaveBeenCalled();
		await setRemindersEnabled(plugin as never, true);
		expect(plugin.remindersSettings.enabled).toBe(true);
		expect(reminderIndexLoad).toHaveBeenCalledOnce();
	});

	it('turns reminders back off when initialization fails', async () => {
		const { setRemindersEnabled } = await loadPluginIntegrationModule();
		const plugin = createPlugin();
		plugin.remindersSettings.enabled = false;
		reminderIndexLoad.mockRejectedValueOnce(new Error('Unreadable folder'));
		await expect(setRemindersEnabled(plugin as never, true)).rejects.toThrow('Unreadable folder');
		expect(plugin.writeRemindersSettings.mock.calls.map(([update]) => update)).toEqual([{ enabled: true }, { enabled: false }]);
		expect(plugin.remindersSettings.enabled).toBe(false);
	});
});

it('opens the reminders view only while reminders are enabled', async () => {
	const { activateRemindersView } = await loadPluginIntegrationModule();
	const plugin = createPlugin();
	await activateRemindersView(plugin as never, 'Work');
	expect(activateOrRevealRemindersLeaf).toHaveBeenCalledExactlyOnceWith(plugin.app.workspace, 'reminders-view', 'Work', expect.any(AbortSignal));
	plugin.remindersSettings.enabled = false;
	await activateRemindersView(plugin as never);
	expect(activateOrRevealRemindersLeaf).toHaveBeenCalledOnce();
});

it('rebuilds the backend for a new folder only while reminders are enabled', async () => {
	const { reinitializeWithFolder } = await loadPluginIntegrationModule();
	const plugin = createPlugin();
	plugin.remindersSettings.enabled = false;
	await reinitializeWithFolder(plugin as never, 'Tasks');
	expect(reminderIndexFactory).not.toHaveBeenCalled();
	plugin.remindersSettings.enabled = true;
	await reinitializeWithFolder(plugin as never, 'Tasks');
	expect(reminderIndexFactory).toHaveBeenCalledWith(plugin.app, 'Tasks', gatedIndexOptions);
});
