import { vi } from 'vitest';
import { SyncRuntime } from './runtime';
import type { CrateSettings } from '../plugin/settings-types';
import type { SyncResult, SyncState } from './types';

const CONFIG_DIR = '.vault-config';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/crate`;

export type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
};

export type RuntimeSyncEngineStub = {
	getState?: () => SyncState;
	sync(callback: (current: number, total: number) => void): Promise<SyncResult>;
	initialSync(callback: (current: number, total: number) => void): Promise<SyncResult>;
	forceFullSync(callback: (current: number, total: number) => void): Promise<SyncResult>;
};

export type RuntimeStatusBarStub = {
	setSyncProgress(current: number, total: number): void;
	clearSyncProgress(): void;
};

export function isAcceptingEvents(runtime: SyncRuntime): boolean {
	return (runtime as unknown as { acceptingEvents: boolean }).acceptingEvents;
}

export function setAcceptingEvents(runtime: SyncRuntime, acceptingEvents: boolean): void {
	(runtime as unknown as { acceptingEvents: boolean }).acceptingEvents = acceptingEvents;
}

export function setStatusBar(runtime: SyncRuntime, statusBar: RuntimeStatusBarStub): void {
	(runtime as unknown as { statusBar: RuntimeStatusBarStub | null }).statusBar = statusBar;
}

export function setSyncEngine(runtime: SyncRuntime, syncEngine: RuntimeSyncEngineStub): void {
	(runtime as unknown as { syncEngine: RuntimeSyncEngineStub | null }).syncEngine = syncEngine;
}

export function setApiClient(runtime: SyncRuntime, apiClient: {
	testConnection(): Promise<{ success: boolean; error?: string }>;
	putSharedSettings(shared: unknown): Promise<void>;
	revokeCurrentToken?(): Promise<{ success: boolean }>;
} | null): void {
	(runtime as unknown as { apiClient: unknown }).apiClient = apiClient === null ? null : {
		setAbortSignal: () => {}, configureUploadJournal: () => {}, getRequestDiagnostics: () => ({ clientSession: crypto.randomUUID(), requests: [] }), ...apiClient,
	};
}

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
		showStatusBar: false,
		syncHistory: [],
		pushEnabled: false,
		debugLogging: false,
		debounceDelay: 5,
		...overrides,
	};
}

export function createRuntimeHarness(settingsOverrides: Partial<CrateSettings> = {}) {
	const settings = createSettings(settingsOverrides);
	const plugin = {
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
	const secretStorage = {
		has: vi.fn(() => true),
		get: vi.fn(() => 'auth-token'),
		set: vi.fn(),
		delete: vi.fn(),
	};
	const persistSettings = vi.fn(async () => {});

	return {
		plugin,
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

export async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}
