import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncEngine } from './engine';
import { SyncApiClient } from './api';
import { createEmptySyncResult } from './sync-result';
import {
	FOREGROUND_SYNC_COOLDOWN_MS,
	FOREGROUND_SYNC_DEBOUNCE_MS,
	SyncRuntime,
} from './runtime';
import { MAX_SYNC_HISTORY, MAX_SYNC_HISTORY_PATHS, SECRET_KEYS, type CrateSettings, type SyncResult, type SyncState } from '../plugin/types';

const CONFIG_DIR = '.vault-config';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/obsidian-crate`;

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
};

type RuntimeSyncEngineStub = {
	getState?: () => SyncState;
	sync(callback: (current: number, total: number) => void): Promise<SyncResult>;
	initialSync(callback: (current: number, total: number) => void): Promise<SyncResult>;
	forceFullSync(callback: (current: number, total: number) => void): Promise<SyncResult>;
};

type RuntimeStatusBarStub = {
	setSyncProgress(current: number, total: number): void;
	clearSyncProgress(): void;
};

function isAcceptingEvents(runtime: SyncRuntime): boolean {
	return (runtime as unknown as { acceptingEvents: boolean }).acceptingEvents;
}

function setAcceptingEvents(runtime: SyncRuntime, acceptingEvents: boolean): void {
	(runtime as unknown as { acceptingEvents: boolean }).acceptingEvents = acceptingEvents;
}

function setStatusBar(runtime: SyncRuntime, statusBar: RuntimeStatusBarStub): void {
	(runtime as unknown as { statusBar: RuntimeStatusBarStub | null }).statusBar = statusBar;
}

function setSyncEngine(runtime: SyncRuntime, syncEngine: RuntimeSyncEngineStub): void {
	(runtime as unknown as { syncEngine: RuntimeSyncEngineStub | null }).syncEngine = syncEngine;
}

function setApiClient(runtime: SyncRuntime, apiClient: {
	testConnection(): Promise<{ success: boolean; error?: string }>;
	putSharedSettings(shared: unknown): Promise<void>;
} | null): void {
	(runtime as unknown as { apiClient: typeof apiClient }).apiClient = apiClient;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function createSettings(overrides: Partial<CrateSettings> = {}): CrateSettings {
	return {
		workerUrl: 'https://worker.example',
		cloudflareAccountId: '',
		workerName: '',
		bucketName: '',
		databaseId: '',
		lastSync: null,
		lastSeq: 0,
		deviceId: 'device-1',
		ignorePatterns: ['.trash/', '*.tmp'],
		syncOnStartup: true,
		syncOnResume: true,
		syncInterval: 0,
		showStatusBar: false,
		syncHistory: [],
		pushEnabled: false,
		syncDebugLogging: false,
		debounceDelay: 5,
		...overrides,
	};
}

function createRuntimeHarness(settingsOverrides: Partial<CrateSettings> = {}) {
	const settings = createSettings(settingsOverrides);
	const plugin = {
		app: {
			vault: {
				adapter: {
					exists: vi.fn().mockResolvedValue(false),
					read: vi.fn(),
					remove: vi.fn(),
					write: vi.fn(),
					stat: vi.fn(),
					readBinary: vi.fn(),
				},
				getFiles: vi.fn(() => []),
			},
			},
			manifest: {
				dir: PLUGIN_DIR,
			},
		};
	const secretStorage = {
		has: vi.fn(() => true),
		get: vi.fn(() => 'auth-token'),
		set: vi.fn(),
		delete: vi.fn(),
	};
	const persistSettings = vi.fn(async () => {});

	return {
		runtime: new SyncRuntime(
			plugin as never,
			settings,
			secretStorage as never,
			persistSettings,
		),
		persistSettings,
		secretStorage,
		settings,
	};
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe('SyncRuntime startup event handling', () => {
	let startupSync: Deferred<SyncResult>;

	beforeEach(() => {
		startupSync = createDeferred<SyncResult>();

		vi.spyOn(SyncEngine.prototype, 'initialize').mockResolvedValue(undefined);
		vi.spyOn(SyncEngine.prototype, 'sync').mockImplementation(async () => startupSync.promise);
		vi.spyOn(SyncApiClient.prototype, 'registerToken').mockResolvedValue({ id: 'token-id' });
		vi.spyOn(SyncEngine.prototype as unknown as { debouncedSync(): void }, 'debouncedSync').mockImplementation(() => {});
	});

	afterEach(async () => {
		startupSync.resolve(createEmptySyncResult());
		await flushMicrotasks();
		vi.restoreAllMocks();
	});

	it.each([
		{
			name: 'create',
			invoke: (runtime: SyncRuntime) => runtime.onFileChange({ path: 'notes/new.md' } as never),
		},
		{
			name: 'edit',
			invoke: (runtime: SyncRuntime) => runtime.onFileChange({ path: 'notes/existing.md' } as never),
		},
		{
			name: 'delete',
			invoke: (runtime: SyncRuntime) => runtime.onFileDelete({ path: 'notes/removed.md' } as never),
		},
		{
			name: 'rename',
			invoke: (runtime: SyncRuntime) => runtime.onFileRename(
				{ path: 'notes/renamed.md' } as never,
				'notes/original.md',
			),
		},
	])('ignores $name events while startup sync is in flight', async ({ invoke }) => {
		const { runtime } = createRuntimeHarness();

		await runtime.initialize();

		expect(isAcceptingEvents(runtime)).toBe(false);

		invoke(runtime);

		expect(runtime.getPendingPaths()).toEqual([]);
	});

	it('starts accepting events after startup sync finishes', async () => {
		const { runtime } = createRuntimeHarness();

		await runtime.initialize();

		expect(isAcceptingEvents(runtime)).toBe(false);

		startupSync.resolve(createEmptySyncResult());
		await vi.waitFor(() => {
			expect(isAcceptingEvents(runtime)).toBe(true);
		});

		runtime.onFileChange({ path: 'notes/existing.md' } as never);
		runtime.onFileChange({ path: 'notes/existing.md' } as never);

		expect(runtime.getPendingPaths()).toEqual(['notes/existing.md']);
	});
});

describe('SyncRuntime foreground sync', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('debounces foreground triggers and runs a sync', async () => {
		const { runtime, persistSettings } = createRuntimeHarness();
		const sync = vi.fn(async () => createEmptySyncResult());

		setAcceptingEvents(runtime, true);
		setSyncEngine(runtime, {
			getState: () => ({ status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 }),
			sync,
			initialSync: vi.fn(async () => createEmptySyncResult()),
			forceFullSync: vi.fn(async () => createEmptySyncResult()),
		});

		runtime.triggerForegroundSync('focus');
		runtime.triggerForegroundSync('visible');

		expect(sync).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_DEBOUNCE_MS);

		expect(sync).toHaveBeenCalledTimes(1);
		expect(persistSettings).toHaveBeenCalledTimes(1);
	});

	it('throttles repeated foreground syncs with a cooldown', async () => {
		const { runtime } = createRuntimeHarness();
		const sync = vi.fn(async () => createEmptySyncResult());

		setAcceptingEvents(runtime, true);
		setSyncEngine(runtime, {
			getState: () => ({ status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 }),
			sync,
			initialSync: vi.fn(async () => createEmptySyncResult()),
			forceFullSync: vi.fn(async () => createEmptySyncResult()),
		});

		runtime.triggerForegroundSync('focus');
		await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_DEBOUNCE_MS);
		expect(sync).toHaveBeenCalledTimes(1);

		runtime.triggerForegroundSync('visible');
		await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_DEBOUNCE_MS);
		expect(sync).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_COOLDOWN_MS);
		runtime.triggerForegroundSync('online');
		await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_DEBOUNCE_MS);
		expect(sync).toHaveBeenCalledTimes(2);
	});

	it('does not foreground sync while startup events are paused or setting is disabled', async () => {
		const { runtime: pausedRuntime } = createRuntimeHarness();
		const pausedSync = vi.fn(async () => createEmptySyncResult());
		setSyncEngine(pausedRuntime, {
			getState: () => ({ status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 }),
			sync: pausedSync,
			initialSync: vi.fn(async () => createEmptySyncResult()),
			forceFullSync: vi.fn(async () => createEmptySyncResult()),
		});

		pausedRuntime.triggerForegroundSync('focus');
		await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_DEBOUNCE_MS);
		expect(pausedSync).not.toHaveBeenCalled();

		const { runtime: disabledRuntime } = createRuntimeHarness({ syncOnResume: false });
		const disabledSync = vi.fn(async () => createEmptySyncResult());
		setAcceptingEvents(disabledRuntime, true);
		setSyncEngine(disabledRuntime, {
			getState: () => ({ status: 'idle', lastSync: null, lastError: null, pendingChanges: 0, conflictCount: 0 }),
			sync: disabledSync,
			initialSync: vi.fn(async () => createEmptySyncResult()),
			forceFullSync: vi.fn(async () => createEmptySyncResult()),
		});

		disabledRuntime.triggerForegroundSync('focus');
		await vi.advanceTimersByTimeAsync(FOREGROUND_SYNC_DEBOUNCE_MS);
		expect(disabledSync).not.toHaveBeenCalled();
	});
});

describe('SyncRuntime teardown and reinitialization', () => {
	let startupSyncs: Deferred<SyncResult>[];
	let queuedStartupSyncs: Deferred<SyncResult>[];

	beforeEach(() => {
		startupSyncs = [createDeferred<SyncResult>(), createDeferred<SyncResult>()];
		queuedStartupSyncs = [...startupSyncs];

		vi.spyOn(SyncEngine.prototype, 'initialize').mockResolvedValue(undefined);
		vi.spyOn(SyncEngine.prototype, 'sync').mockImplementation(async () => {
			const nextSync = queuedStartupSyncs.shift();
			return nextSync ? nextSync.promise : createEmptySyncResult();
		});
		vi.spyOn(SyncApiClient.prototype, 'registerToken').mockResolvedValue({ id: 'token-id' });
		vi.spyOn(SyncEngine.prototype as unknown as { debouncedSync(): void }, 'debouncedSync').mockImplementation(() => {});
	});

	afterEach(async () => {
		for (const startupSync of startupSyncs) {
			startupSync.resolve(createEmptySyncResult());
		}
		await flushMicrotasks();
		vi.restoreAllMocks();
	});

	it('keeps events paused until the latest startup sync finishes after reinitialize', async () => {
		const { runtime } = createRuntimeHarness();
		const destroy = vi.spyOn(SyncEngine.prototype, 'destroy');

		await runtime.initialize();
		await runtime.initialize();

		expect(destroy).toHaveBeenCalledTimes(1);
		expect(isAcceptingEvents(runtime)).toBe(false);

		startupSyncs[0]?.resolve(createEmptySyncResult());
		await flushMicrotasks();

		expect(isAcceptingEvents(runtime)).toBe(false);

		runtime.onFileChange({ path: 'notes/still-blocked.md' } as never);
		expect(runtime.getPendingPaths()).toEqual([]);

		startupSyncs[1]?.resolve(createEmptySyncResult());
		await vi.waitFor(() => {
			expect(isAcceptingEvents(runtime)).toBe(true);
		});

		runtime.onFileChange({ path: 'notes/active.md' } as never);
		expect(runtime.getPendingPaths()).toEqual(['notes/active.md']);
	});

	it('does not re-enable events after destroy while startup sync is in flight', async () => {
		const { runtime } = createRuntimeHarness();

		await runtime.initialize();
		runtime.destroy();

		expect(isAcceptingEvents(runtime)).toBe(false);

		startupSyncs[0]?.resolve(createEmptySyncResult());
		await flushMicrotasks();

		expect(isAcceptingEvents(runtime)).toBe(false);
		runtime.onFileChange({ path: 'notes/after-destroy.md' } as never);
		expect(runtime.getPendingPaths()).toEqual([]);
	});
});

describe('SyncRuntime operation wrappers', () => {
	it.each([
		{ method: (runtime: SyncRuntime, callback: (current: number, total: number) => void) => runtime.sync(callback), historyType: 'sync' as const },
		{ method: (runtime: SyncRuntime, callback: (current: number, total: number) => void) => runtime.initialSync(callback), historyType: 'initial' as const },
		{ method: (runtime: SyncRuntime, callback: (current: number, total: number) => void) => runtime.forceFullSync(callback), historyType: 'force' as const },
	])('records history, persists settings, and clears progress for $method', async ({ method, historyType }) => {
		const { runtime, persistSettings, settings } = createRuntimeHarness();
		const result: SyncResult = {
			...createEmptySyncResult(),
			success: true,
			uploaded: 2,
			uploadedPaths: ['notes/a.md'],
		};
		const progressCallback = vi.fn();
		const listener = vi.fn();
		const clearSyncProgress = vi.fn();
		const setSyncProgress = vi.fn();

		setStatusBar(runtime, {
			setSyncProgress,
			clearSyncProgress,
		});
		setSyncEngine(runtime, {
			sync: vi.fn(async (callback: (current: number, total: number) => void) => {
				callback(1, 2);
				return result;
			}),
			initialSync: vi.fn(async (callback: (current: number, total: number) => void) => {
				callback(1, 2);
				return result;
			}),
			forceFullSync: vi.fn(async (callback: (current: number, total: number) => void) => {
				callback(1, 2);
				return result;
			}),
		});

		runtime.addProgressListener(listener);

		const methodResult = await method(runtime, progressCallback);

		expect(methodResult).toBe(result);
		expect(progressCallback).toHaveBeenCalledWith(1, 2);
		expect(listener).toHaveBeenCalledWith(1, 2);
		expect(setSyncProgress).toHaveBeenCalledWith(1, 2);
		expect(clearSyncProgress).toHaveBeenCalledTimes(1);
		expect(persistSettings).toHaveBeenCalledTimes(1);
		expect(settings.syncHistory[0]?.type).toBe(historyType);
		expect(settings.syncHistory[0]?.uploaded).toBe(2);
	});

	it('caps stored sync history file paths', async () => {
		const { runtime, settings } = createRuntimeHarness();
		const uploadedPaths = Array.from({ length: MAX_SYNC_HISTORY_PATHS + 5 }, (_, index) => `notes/${index}.md`);

		setSyncEngine(runtime, {
			sync: vi.fn(async () => ({
				...createEmptySyncResult(),
				success: true,
				uploaded: uploadedPaths.length,
				uploadedPaths,
			})),
			initialSync: vi.fn(async () => createEmptySyncResult()),
			forceFullSync: vi.fn(async () => createEmptySyncResult()),
		});

		await runtime.sync();

		expect(settings.syncHistory[0]?.uploadedPaths).toHaveLength(MAX_SYNC_HISTORY_PATHS);
		expect(settings.syncHistory[0]?.uploadedPaths?.at(-1)).toBe(`notes/${MAX_SYNC_HISTORY_PATHS - 1}.md`);
	});

	it('resets sync state when applying infrastructure config', async () => {
		const { runtime, settings } = createRuntimeHarness({
			lastSeq: 42,
			lastSync: '2026-01-01T00:00:00.000Z',
			syncHistory: [
				{
					timestamp: '2026-01-01T00:00:00.000Z',
					type: 'sync',
					success: true,
					uploaded: 1,
					downloaded: 0,
					deleted: 0,
					errorCount: 0,
					conflictCount: 0,
				},
			],
		});
		const initialize = vi.spyOn(runtime, 'initialize').mockResolvedValue(undefined);

		await runtime.applyInfrastructureConfig({
			workerUrl: 'https://worker.example',
			authToken: ' new-auth-token ',
			workerName: ' worker-name ',
			bucketName: ' bucket-name ',
			databaseId: ' db-id ',
			accountId: ' acct-1 ',
		});

		expect(settings.lastSeq).toBe(0);
		expect(settings.lastSync).toBeNull();
		expect(settings.syncHistory).toEqual([]);
		expect(settings.workerName).toBe('worker-name');
		expect(settings.bucketName).toBe('bucket-name');
		expect(settings.databaseId).toBe('db-id');
		expect(settings.cloudflareAccountId).toBe('acct-1');
		expect(initialize).toHaveBeenCalledTimes(1);
	});

	it('clears sync state when clearing configuration', async () => {
		const { runtime, settings } = createRuntimeHarness({
			lastSeq: 42,
			lastSync: '2026-01-01T00:00:00.000Z',
			syncHistory: [
				{
					timestamp: '2026-01-01T00:00:00.000Z',
					type: 'sync',
					success: true,
					uploaded: 1,
					downloaded: 0,
					deleted: 0,
					errorCount: 0,
					conflictCount: 0,
				},
			],
		});

		await runtime.clearSyncConfiguration();

		expect(settings.lastSeq).toBe(0);
		expect(settings.lastSync).toBeNull();
		expect(settings.syncHistory).toEqual([]);
		expect(settings.workerUrl).toBe('');
	});

	it('clears stored Cloudflare credentials when requested during reset', async () => {
		const { runtime, settings, secretStorage } = createRuntimeHarness({
			cloudflareAccountId: 'acct-123',
		});

		await runtime.clearSyncConfiguration({ clearCloudflareCredentials: true });

		expect(settings.cloudflareAccountId).toBe('');
		expect(secretStorage.delete).toHaveBeenCalledWith(SECRET_KEYS.AUTH_TOKEN);
		expect(secretStorage.delete).toHaveBeenCalledWith(SECRET_KEYS.CLOUDFLARE_API_TOKEN);
	});

	it('caps stored sync history entries', async () => {
		const { runtime, settings } = createRuntimeHarness();

		setSyncEngine(runtime, {
			sync: vi.fn(async () => createEmptySyncResult()),
			initialSync: vi.fn(async () => createEmptySyncResult()),
			forceFullSync: vi.fn(async () => createEmptySyncResult()),
		});

		for (let index = 0; index < MAX_SYNC_HISTORY + 5; index++) {
			await runtime.sync();
		}

		expect(settings.syncHistory).toHaveLength(MAX_SYNC_HISTORY);
	});

	it('pushes shared settings through the current API client', async () => {
		const { runtime } = createRuntimeHarness({
			ignorePatterns: ['*.tmp'],
			syncOnStartup: false,
			syncOnResume: false,
			syncInterval: 15,
			showStatusBar: true,
			pushEnabled: true,
		});
		const putSharedSettings = vi.fn(async () => {});
		setApiClient(runtime, {
			putSharedSettings,
			testConnection: vi.fn(async () => ({ success: true })),
		});

		await runtime.pushSharedSettings();

		expect(putSharedSettings).toHaveBeenCalledWith({
			ignorePatterns: ['*.tmp'],
			syncOnStartup: false,
			syncOnResume: false,
			syncInterval: 15,
			showStatusBar: true,
			pushEnabled: true,
		});
	});

	it('delegates connection tests to the API client when configured', async () => {
		const { runtime } = createRuntimeHarness();
		const testConnection = vi.fn(async () => ({ success: false, error: 'boom' }));
		setApiClient(runtime, {
			putSharedSettings: vi.fn(async () => {}),
			testConnection,
		});

		await expect(runtime.testConnection()).resolves.toEqual({ success: false, error: 'boom' });
		expect(testConnection).toHaveBeenCalledTimes(1);
	});
});
