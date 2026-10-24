import type { SyncEngineContexts } from './contexts';
import { vi } from 'vitest';
import { SyncEngine } from './engine';
import type { ConflictStore } from '../conflict/store';
import { createEmptySyncResult } from '../sync-result';
import type { CrateSettings } from '../../plugin/settings-types';
import type { FileManifest, UploadResult } from '../../protocol/sync-types';
import type { SyncResult } from '../types';
import { LocalManifest } from '../manifest/manifest';
import { getCheckpointAuthority } from '../connection/worker-url';
import { createTestSettings } from '@/test/factories/settings';

const CONFIG_DIR = '.vault-config';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/crate`;

type MockAdapter = {
	read: ReturnType<typeof vi.fn>;
	write: ReturnType<typeof vi.fn>;
	append: ReturnType<typeof vi.fn>;
	readBinary: ReturnType<typeof vi.fn<(path: string) => Promise<ArrayBuffer>>>;
	stat: ReturnType<typeof vi.fn<(path: string) => Promise<{ type: string; size: number; mtime: number } | null>>>;
	exists: ReturnType<typeof vi.fn>;
	remove: ReturnType<typeof vi.fn<(path: string) => Promise<void>>>;
	writeBinary: ReturnType<typeof vi.fn<(path: string, content: ArrayBuffer) => Promise<void>>>;
	mkdir: ReturnType<typeof vi.fn>;
	list: ReturnType<typeof vi.fn<(path: string) => Promise<{ files: string[]; folders: string[] }>>>;
};

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
		(engine as unknown as { contexts: SyncEngineContexts }).contexts,
		'incrementalSync',
	).mockResolvedValue(result);
}

export function toArrayBuffer(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer;
}

export function createNamedAbortError(message = 'Sync request aborted'): Error {
	const error = new Error(message);
	error.name = 'AbortError';
	return error;
}

/** Orchestration tests only; use the persistent harness for file transfer and recovery. */
export function createHarness(settingsOverrides: Partial<CrateSettings> = {}) {
	const settings = createTestSettings({ deviceId: 'dev-1', ignorePatterns: ['.trash/', '*.tmp'], ...settingsOverrides });

	const stored = new Map<string, string>();
	const adapter: MockAdapter = {
		read: vi.fn(async (path: string) => stored.get(path)),
		write: vi.fn(async (path: string, content: string) => { stored.set(path, content); }),
		append: vi.fn(async (path: string, content: string) => { stored.set(path, (stored.get(path) ?? '') + content); }),
		readBinary: vi.fn<(path: string) => Promise<ArrayBuffer>>(),
		stat: vi.fn<(path: string) => Promise<{ type: string; size: number; mtime: number } | null>>(),
		exists: vi.fn(async (path: string) => stored.has(path)),
		remove: vi.fn(async (path: string) => { stored.delete(path); }),
		writeBinary: vi.fn<(path: string, content: ArrayBuffer) => Promise<void>>().mockResolvedValue(),
		mkdir: vi.fn(),
		list: vi.fn<(path: string) => Promise<{ files: string[]; folders: string[] }>>(),
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
		// The engine wraps these mocks directly; see createFiles below.
		getFileTransport: () => ({ transport: null, clientSession: 'test-session' }),
		getRequestDiagnostics: vi.fn(() => ({ clientSession: 'test-session', requests: [] })),
		// Local bookkeeping rather than requests, so offline tests do not count them.
		getRequestTimings: () => undefined,
		resetRequestTimings: () => {},
		recoverUploads: vi.fn(async () => {}),
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
		getPendingRestores: vi.fn<() => Array<{ path: string }>>(() => []),
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

	const createFiles = () => ({
		...api,
		getUploadDiagnostics: () => [],
		recordMergeApplication: vi.fn(async () => {}),
		restoreFileVersion: vi.fn(async () => {}),
		finishRestore: vi.fn(async () => {}),
	});

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

	const manifest = new LocalManifest(plugin.app as never, plugin.manifest as never, getCheckpointAuthority(settings) || 'unconfigured');
	const engine = new SyncEngine(plugin as never, api as never, settings, { localManifest: manifest, createFiles: createFiles as never });

	const spies = {
		load: vi.spyOn(manifest, 'load'),
		close: vi.spyOn(manifest, 'close'),
		save: vi.spyOn(manifest, 'save'),
		hashMatches: vi.spyOn(manifest, 'hashMatches'),
		hasFile: vi.spyOn(manifest, 'hasFile'),
		getEntry: vi.spyOn(manifest, 'getEntry'),
		getAllPaths: vi.spyOn(manifest, 'getAllPaths'),
		getManifest: vi.spyOn(manifest, 'getManifest'),
		setEntry: vi.spyOn(manifest, 'setEntry'),
		removeEntry: vi.spyOn(manifest, 'removeEntry'),
		recordRename: vi.spyOn(manifest, 'recordRename'),
		clear: vi.spyOn(manifest, 'clear'),
		replaceManifest: vi.spyOn(manifest, 'replaceManifest'),
	};
	const localManifest: Omit<LocalManifest, keyof typeof spies> & typeof spies = Object.assign(manifest, spies);

	return { engine, settings, fileManager, workspace, api, vault, localManifest };
}

export type Harness = ReturnType<typeof createHarness>;
