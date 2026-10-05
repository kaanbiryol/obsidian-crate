import { afterEach, expect, vi } from 'vitest';
import { SyncEngine } from './engine';
import type { SyncApiClient } from './api';
import { SyncRuntime } from './runtime';
import type { CrateSettings } from '../plugin/settings-types';

const CONFIG_DIR = '.vault-config';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/crate`;

export type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
};

/** Exercise event gating through a public event, without changing the queue. */
export function expectFileEventsAccepted(runtime: SyncRuntime, accepted: boolean): void {
	const event = vi.spyOn(SyncEngine.prototype, 'onFileChange').mockImplementation(() => {});
	try {
		runtime.onFileChange({ path: 'notes/event-probe.md' } as never);
		expect(event).toHaveBeenCalledTimes(accepted ? 1 : 0);
	} finally { event.mockRestore(); }
}

/** Construct a real runtime session while substituting only the engine's I/O. */
export async function initializeRuntime(runtime: SyncRuntime, overrides: Partial<SyncEngine> = {}): Promise<void> {
	const initialize = vi.spyOn(SyncEngine.prototype, 'initialize').mockImplementationOnce(async function (this: SyncEngine) {
		Object.assign(this, {
			saveHistoryCheckpoint: vi.fn(async () => undefined),
			saveSharedHistoryCheckpoint: vi.fn(async () => undefined),
		}, overrides);
	});
	try { await runtime.initialize({ skipStartupSync: true }); }
	finally { initialize.mockRestore(); }
	if (!runtime.isInitialized()) throw new Error('Runtime did not construct a sync engine');
}

export function mockApiClient(runtime: SyncRuntime, overrides: Partial<SyncApiClient>): void {
	const api = runtime.getApiClient();
	if (!api) throw new Error('Initialize the runtime before mocking its API');
	Object.assign(api, overrides);
}

const runtimes = new Set<SyncRuntime>();
afterEach(() => {
	for (const runtime of runtimes) runtime.destroy();
	runtimes.clear();
});

export function createDeferred<T>(): Deferred<T> {
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
		reading: { enabled: false, folderPath: 'Reading' },
		workerUrl: 'https://worker.example',
		cloudflareDeployment: null,
		lastSync: null,
		lastSeq: 0,
		deviceId: 'device-1',
		ignorePatterns: ['.trash/', '*.tmp'],
		automaticSync: true,
		syncOnStartup: true,
		syncOnResume: true,
		syncInterval: 0,
		syncHistory: [],
		pushEnabled: false,
		debugLogging: false,
		debounceDelay: 5,
		...overrides,
	};
}

export function createRuntimeHarness(settingsOverrides: Partial<CrateSettings> = {}, prepareReminderScope?: () => Promise<void>) {
	const settings = createSettings(settingsOverrides);
	const plugin = {
		registerDomEvent: vi.fn(),
		app: {
			workspace: { layoutReady: true },
			vault: {
				configDir: CONFIG_DIR,
				adapter: {
					exists: vi.fn().mockResolvedValue(false),
					read: vi.fn(),
					remove: vi.fn(),
					write: vi.fn(),
					stat: vi.fn(),
					list: vi.fn(async () => ({ files: [], folders: [] })),
					readBinary: vi.fn(),
				},
				getFiles: vi.fn(() => []),
			},
			},
			manifest: {
				dir: PLUGIN_DIR,
			},
		};
	const secrets = new Map<string, string>([['crate-auth-token', 'auth-token']]);
	const secretStorage = {
		has: vi.fn((key: string) => secrets.has(key)),
		get: vi.fn((key: string): string | null => secrets.get(key) ?? null),
		set: vi.fn((key: string, value: string) => { secrets.set(key, value); }),
		delete: vi.fn((key: string) => { secrets.delete(key); }),
	};
	const persistSettings = vi.fn(async () => {});

	const runtime = new SyncRuntime(plugin as never, settings, secretStorage as never, persistSettings, prepareReminderScope);
	runtimes.add(runtime);

	return {
		plugin,
		runtime,
		persistSettings,
		secretStorage,
		settings,
	};
}

export async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
