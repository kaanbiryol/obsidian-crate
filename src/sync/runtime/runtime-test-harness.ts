import { afterEach, expect, vi } from 'vitest';
import { TFolder } from 'obsidian';
import { SyncEngine, type SyncEngineHooks } from '../engine/engine';
import type { SyncApiClient } from '../worker-api/client';
import { SyncRuntime, type SyncRuntimeOptions } from './runtime';
import type { CrateSettings } from '../../plugin/settings-types';
import { createTestSettings } from '@/test/factories/settings';

const CONFIG_DIR = '.vault-config';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/crate`;

export type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
};

/** Exercise event gating through a public event, without changing the queue: the
 * runtime never defers folder events. */
export function expectFileEventsAccepted(runtime: SyncRuntime, accepted: boolean): void {
	const event = vi.spyOn(SyncEngine.prototype, 'onFileChange').mockImplementation(() => {});
	try {
		runtime.onFileChange(Object.assign(new TFolder(), { path: 'notes/event-probe' }));
		expect(event).toHaveBeenCalledTimes(accepted ? 1 : 0);
	} finally { event.mockRestore(); }
}

/** Construct a real runtime session while substituting only the engine's I/O. */
export async function initializeRuntime(runtime: SyncRuntime, overrides: Partial<SyncEngine> = {}): Promise<void> {
	const initialize = vi.spyOn(SyncEngine.prototype, 'initialize').mockImplementationOnce(async function (this: SyncEngine) {
		Object.assign(this, overrides);
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

export function createRuntimeHarness(settingsOverrides: Partial<CrateSettings> = {}, prepareReminderScope?: () => Promise<void>, options: Pick<SyncRuntimeOptions, 'fileEventsInBackground'> = {}) {
	const settings = createTestSettings({ deviceId: 'device-1', ignorePatterns: ['.trash/', '*.tmp'], ...settingsOverrides });
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
					append: vi.fn(),
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

	// The hooks each initialization handed its engine, so tests can drive them as the engine would.
	const engineHooks: SyncEngineHooks[] = [];
	const runtime = new SyncRuntime(plugin as never, settings, secretStorage as never, persistSettings, {
		prepareReminderScope,
		...options,
		createEngine: (host, api, engineSettings, hooks) => {
			engineHooks.push(hooks);
			return new SyncEngine(host, api, engineSettings, hooks);
		},
	});
	runtimes.add(runtime);

	return {
		plugin,
		runtime,
		/** The hooks of the most recently built engine. */
		engineHooks: () => {
			const hooks = engineHooks.at(-1);
			if (!hooks) throw new Error('Initialize the runtime before reading its engine hooks');
			return hooks;
		},
		persistSettings,
		secretStorage,
		settings,
	};
}

export async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
