import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncEngine } from './engine';
import { createEmptySyncResult } from './sync-result';
import { SyncRuntime } from './runtime';
import type { CrateSettings, SyncResult } from '../types';

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
};

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
		cloudflareTokenExpiresAt: null,
		workerName: '',
		bucketName: '',
		databaseId: '',
		lastSync: null,
		lastSeq: 0,
		deviceId: 'device-1',
		ignorePatterns: ['.trash/', '*.tmp'],
		syncOnStartup: true,
		syncInterval: 0,
		showStatusBar: false,
		syncHistory: [],
		pushEnabled: false,
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
			dir: '.obsidian/plugins/obsidian-crate',
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
		vi.spyOn(SyncEngine.prototype, 'sync').mockImplementation(function (this: SyncEngine) {
			(this as any).updateState({ status: 'syncing' });
			return startupSync.promise.then(result => {
				(this as any).updateState({ status: 'idle' });
				return result;
			});
		});
		vi.spyOn(SyncEngine.prototype as any, 'debouncedSync').mockImplementation(() => {});
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
			expectedPendingPaths: ['notes/new.md'],
		},
		{
			name: 'edit',
			invoke: (runtime: SyncRuntime) => runtime.onFileChange({ path: 'notes/existing.md' } as never),
			expectedPendingPaths: ['notes/existing.md'],
		},
		{
			name: 'delete',
			invoke: (runtime: SyncRuntime) => runtime.onFileDelete({ path: 'notes/removed.md' } as never),
			expectedPendingPaths: ['delete:notes/removed.md'],
		},
		{
			name: 'rename',
			invoke: (runtime: SyncRuntime) => runtime.onFileRename(
				{ path: 'notes/renamed.md' } as never,
				'notes/original.md',
			),
			expectedPendingPaths: ['delete:notes/original.md', 'notes/renamed.md'],
		},
	])('captures $name events while startup sync is in flight', async ({ invoke, expectedPendingPaths }) => {
		const { runtime } = createRuntimeHarness();

		await runtime.initialize();

		expect((runtime as any).acceptingEvents).toBe(true);

		invoke(runtime);

		expect(runtime.getPendingPaths().sort()).toEqual(expectedPendingPaths.slice().sort());
	});

	it('keeps a single queued upload for repeated edits during startup sync', async () => {
		const { runtime } = createRuntimeHarness();

		await runtime.initialize();

		runtime.onFileChange({ path: 'notes/existing.md' } as never);
		runtime.onFileChange({ path: 'notes/existing.md' } as never);

		expect(runtime.getPendingPaths()).toEqual(['notes/existing.md']);

		startupSync.resolve(createEmptySyncResult());
		await flushMicrotasks();

		expect(runtime.getPendingPaths()).toEqual(['notes/existing.md']);
	});
});
