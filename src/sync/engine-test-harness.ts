import { vi } from 'vitest';
import { SyncEngine } from './engine';
import type { ConflictStore } from './conflict-store';
import type { SyncQueueController } from './queue-controller';
import { createEmptySyncResult } from './sync-result';
import type { CrateSettings } from '../plugin/settings-types';
import type { FileManifest, UploadResult } from '../protocol/sync-types';
import type { PreparedUpload, SyncResult } from './types';

const CONFIG_DIR = '.vault-config';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/crate`;

type ManifestEntry = {
	hash: string;
	size: number;
	modified: string;
};

type MockAdapter = {
	read: ReturnType<typeof vi.fn>;
	write: ReturnType<typeof vi.fn>;
	readBinary: ReturnType<typeof vi.fn>;
	stat: ReturnType<typeof vi.fn<(path: string) => Promise<{ type: string; size: number; mtime: number } | null>>>;
	exists: ReturnType<typeof vi.fn>;
	remove: ReturnType<typeof vi.fn>;
	writeBinary: ReturnType<typeof vi.fn>;
	mkdir: ReturnType<typeof vi.fn>;
	list: ReturnType<typeof vi.fn>;
};

export type Harness = {
	engine: SyncEngine;
	settings: CrateSettings;
	fileManager: {
		trashFile: ReturnType<typeof vi.fn>;
	};
	workspace: {
		onLayoutReady: ReturnType<typeof vi.fn>;
		runLayoutReady: () => void;
	};
	api: {
		isConfigured: ReturnType<typeof vi.fn>;
		setAbortSignal: ReturnType<typeof vi.fn>;
		getChanges: ReturnType<typeof vi.fn>;
		uploadFile: ReturnType<typeof vi.fn<(
			path: string,
			content: ArrayBuffer,
			hash: string,
			size: number,
			contentType: string,
		) => Promise<UploadResult>>>;
		deleteFile: ReturnType<typeof vi.fn>;
		downloadFile: ReturnType<typeof vi.fn>;
		getManifest: ReturnType<typeof vi.fn<() => Promise<FileManifest>>>;
		checkForChanges: ReturnType<typeof vi.fn>;
		batchUpload: ReturnType<typeof vi.fn>;
		batchDownload: ReturnType<typeof vi.fn>;
		batchDelete: ReturnType<typeof vi.fn>;
	};
	vault: {
		adapter: MockAdapter;
		getAbstractFileByPath: ReturnType<typeof vi.fn>;
		delete: ReturnType<typeof vi.fn>;
		createFolder: ReturnType<typeof vi.fn>;
		modifyBinary: ReturnType<typeof vi.fn>;
		createBinary: ReturnType<typeof vi.fn>;
		getFiles: ReturnType<typeof vi.fn>;
	};
	localManifest: {
		load: ReturnType<typeof vi.fn>;
		save: ReturnType<typeof vi.fn>;
		hashMatches: ReturnType<typeof vi.fn>;
		hasFile: ReturnType<typeof vi.fn>;
		getEntry: ReturnType<typeof vi.fn>;
		getAllPaths: ReturnType<typeof vi.fn>;
		getManifest: ReturnType<typeof vi.fn>;
		setEntry: ReturnType<typeof vi.fn>;
		removeEntry: ReturnType<typeof vi.fn>;
		clear: ReturnType<typeof vi.fn>;
	};
};

export function setEngineLocalManifest(
	engine: SyncEngine,
	localManifest: Harness['localManifest'],
): void {
	(engine as unknown as { localManifest: Harness['localManifest'] }).localManifest = localManifest;
}

function getQueueController(engine: SyncEngine): SyncQueueController {
	return (engine as unknown as { queueController: SyncQueueController }).queueController;
}

export function getPendingPaths(engine: SyncEngine): Set<string> {
	return (getQueueController(engine) as unknown as { pendingPaths: Set<string> }).pendingPaths;
}

export function spyOnDebouncedSync(engine: SyncEngine) {
	return vi
		.spyOn(getQueueController(engine) as unknown as { debouncedSync(): void }, 'debouncedSync')
		.mockImplementation(() => {});
}

export async function flushPendingChanges(engine: SyncEngine): Promise<void> {
	await (getQueueController(engine) as unknown as { processPendingChanges(): Promise<void> }).processPendingChanges();
}

export function setSyncStatus(engine: SyncEngine, status: 'idle' | 'syncing' | 'error'): void {
	(engine as unknown as { state: { status: 'idle' | 'syncing' | 'error' } }).state.status = status;
}

export function getConsecutiveCheckFailures(engine: SyncEngine): number {
	return (engine as unknown as { lifecycle: { checkFailureCount: number } }).lifecycle.checkFailureCount;
}

export async function runPeriodicCheck(engine: SyncEngine): Promise<void> {
	await (engine as unknown as { lifecycle: { periodicCheck(): Promise<void> } }).lifecycle.periodicCheck();
}

export function spyOnConflictRecovery(engine: SyncEngine) {
	const conflictStore = (engine as unknown as { conflictStore: ConflictStore }).conflictStore;
	return vi.spyOn(conflictStore, 'recoverFromVault');
}

export function createSyncResult(): SyncResult {
	return createEmptySyncResult();
}

export function spyOnIncrementalSync(engine: SyncEngine, result: SyncResult | null) {
	return vi.spyOn(
		engine as unknown as { incrementalSync(): Promise<SyncResult | null> },
		'incrementalSync',
	).mockResolvedValue(result);
}

export function spyOnPrepareUploadsFromVaultFiles(
	engine: SyncEngine,
	implementation: () => Promise<PreparedUpload[]>,
) {
	return vi.spyOn(
		engine as unknown as { prepareUploadsFromVaultFiles(): Promise<PreparedUpload[]> },
		'prepareUploadsFromVaultFiles',
	).mockImplementation(implementation);
}

function createSettings(): CrateSettings {
	return {
		workerUrl: 'https://worker.example',
		cloudflareDeployment: null,
		lastSync: null,
		lastSeq: 0,
		deviceId: 'dev-1',
		ignorePatterns: ['.trash/', '*.tmp'],
		syncOnStartup: false,
		syncOnResume: true,
		syncInterval: 0,
		showStatusBar: true,
		syncHistory: [],
		pushEnabled: false,
		syncDebugLogging: false,
		debounceDelay: 5,
	};
}

export function toArrayBuffer(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

export function createNamedAbortError(message = 'Sync request aborted'): Error {
	const error = new Error(message);
	error.name = 'AbortError';
	return error;
}

export function createHarness(settingsOverrides: Partial<CrateSettings> = {}): Harness {
	const settings = { ...createSettings(), ...settingsOverrides };

	const adapter: MockAdapter = {
		read: vi.fn(),
		write: vi.fn(),
		readBinary: vi.fn(),
		stat: vi.fn<(path: string) => Promise<{ type: string; size: number; mtime: number } | null>>(),
		exists: vi.fn(),
		remove: vi.fn(),
		writeBinary: vi.fn(),
		mkdir: vi.fn(),
		list: vi.fn(),
	};

	const vault = {
		configDir: CONFIG_DIR,
		adapter,
		getAbstractFileByPath: vi.fn(),
		delete: vi.fn(),
		createFolder: vi.fn(),
		modifyBinary: vi.fn(),
		createBinary: vi.fn(),
		getFiles: vi.fn(),
	};
	adapter.stat.mockImplementation(async (path: string) => {
		const abstractFile = vault.getAbstractFileByPath(path) as { stat?: { size: number; mtime: number } } | null;
		const indexedFile = (vault.getFiles() as Array<{ path: string; stat?: { size: number; mtime: number } }> | undefined)
			?.find(file => file.path === path);
		const stat = abstractFile?.stat ?? indexedFile?.stat;
		return stat ? { type: 'file', size: stat.size, mtime: stat.mtime } : null;
	});

	const api = {
		isConfigured: vi.fn().mockReturnValue(true),
		setAbortSignal: vi.fn(),
		getChanges: vi.fn(),
		uploadFile: vi.fn<(
			path: string,
			content: ArrayBuffer,
			hash: string,
			size: number,
			contentType: string,
		) => Promise<UploadResult>>(),
		deleteFile: vi.fn(),
		downloadFile: vi.fn(),
		getManifest: vi.fn<() => Promise<FileManifest>>(),
		checkForChanges: vi.fn(),
		batchUpload: vi.fn().mockImplementation(async (files: Array<{ path: string; hash: string; size: number }>) => ({
			success: true,
			results: files.map(f => ({ path: f.path, success: true, hash: f.hash })),
		})),
		batchDownload: vi.fn().mockResolvedValue({ files: [] }),
		batchDelete: vi.fn().mockImplementation(async (paths: string[]) => ({
			success: true,
			deleted: paths,
		})),
	};

	const fileManager = {
		trashFile: vi.fn(),
	};
	let layoutReadyCallback: (() => void) | null = null;
	const workspace = {
		onLayoutReady: vi.fn((callback: () => void) => {
			layoutReadyCallback = callback;
		}),
		runLayoutReady: () => layoutReadyCallback?.(),
	};

	const plugin = {
		app: { vault, fileManager, workspace },
		manifest: { dir: PLUGIN_DIR },
	};

	const engine = new SyncEngine(plugin as never, api as never, settings);

	const manifestFiles: Record<string, ManifestEntry> = {};
	const localManifest = {
		load: vi.fn(),
		save: vi.fn(),
		hashMatches: vi.fn((path: string, hash: string) => manifestFiles[path]?.hash === hash),
		hasFile: vi.fn((path: string) => path in manifestFiles),
		getEntry: vi.fn((path: string) => manifestFiles[path]),
		getAllPaths: vi.fn(() => Object.keys(manifestFiles)),
		getManifest: vi.fn(() => ({ version: 1, files: { ...manifestFiles } })),
		setEntry: vi.fn((path: string, entry: { hash: string; size: number; modified: string }) => {
			manifestFiles[path] = entry;
		}),
		removeEntry: vi.fn((path: string) => {
			delete manifestFiles[path];
		}),
		clear: vi.fn(() => {
			for (const path of Object.keys(manifestFiles)) {
				delete manifestFiles[path];
			}
		}),
		replaceManifest: vi.fn((manifest: FileManifest) => {
			for (const path of Object.keys(manifestFiles)) delete manifestFiles[path];
			Object.assign(manifestFiles, structuredClone(manifest.files));
		}),
	};

	setEngineLocalManifest(engine, localManifest);

	return { engine, settings, fileManager, workspace, api, vault, localManifest };
}
