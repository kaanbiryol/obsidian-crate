import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncEngine } from './engine';
import { computeHash } from './hasher';
import { createEmptySyncResult } from './sync-result';
import { prepareUploadFromVaultFile, type TransferContext } from './transfer';
import type { CrateSettings, FileDiff, PreparedUpload, SyncResult } from '../plugin/types';
import { MAX_FILE_SIZE_BYTES } from '../plugin/types';

const CONFIG_DIR = '.vault-config';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/obsidian-crate`;
const CONFIG_PLUGINS_DIR = `${CONFIG_DIR}/plugins`;
const TRACKED_PLUGIN_MAIN_PATH = `${CONFIG_DIR}/plugins/foo/main.js`;
const HIDDEN_WORKSPACE_PATH = `${CONFIG_DIR}/workspace.json`;

type ManifestEntry = {
	hash: string;
	size: number;
	modified: string;
};

type MockAdapter = {
	readBinary: ReturnType<typeof vi.fn>;
	stat: ReturnType<typeof vi.fn>;
	exists: ReturnType<typeof vi.fn>;
	remove: ReturnType<typeof vi.fn>;
	writeBinary: ReturnType<typeof vi.fn>;
	mkdir: ReturnType<typeof vi.fn>;
	list: ReturnType<typeof vi.fn>;
};

type Harness = {
	engine: SyncEngine;
	settings: CrateSettings;
	fileManager: {
		trashFile: ReturnType<typeof vi.fn>;
	};
	api: {
		isConfigured: ReturnType<typeof vi.fn>;
		setAbortSignal: ReturnType<typeof vi.fn>;
		getChanges: ReturnType<typeof vi.fn>;
		uploadFile: ReturnType<typeof vi.fn>;
		deleteFile: ReturnType<typeof vi.fn>;
		downloadFile: ReturnType<typeof vi.fn>;
		getManifest: ReturnType<typeof vi.fn>;
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

function setEngineLocalManifest(
	engine: SyncEngine,
	localManifest: Harness['localManifest'],
): void {
	(engine as unknown as { localManifest: Harness['localManifest'] }).localManifest = localManifest;
}

function getPendingPaths(engine: SyncEngine): Set<string> {
	return (engine as unknown as { pendingPaths: Set<string> }).pendingPaths;
}

function spyOnDebouncedSync(engine: SyncEngine) {
	return vi.spyOn(engine as unknown as { debouncedSync(): void }, 'debouncedSync').mockImplementation(() => {});
}

function matchPattern(engine: SyncEngine, path: string, pattern: string): boolean {
	return (engine as unknown as {
		matchPattern(pathToCheck: string, patternToCheck: string): boolean;
	}).matchPattern(path, pattern);
}

function shouldIgnorePath(engine: SyncEngine, path: string): boolean {
	return (engine as unknown as { shouldIgnore(pathToCheck: string): boolean }).shouldIgnore(path);
}

async function runIncrementalSync(engine: SyncEngine): Promise<SyncResult | null> {
	return (engine as unknown as { incrementalSync(): Promise<SyncResult | null> }).incrementalSync();
}

async function flushPendingChanges(engine: SyncEngine): Promise<void> {
	await (engine as unknown as { processPendingChanges(): Promise<void> }).processPendingChanges();
}

function setSyncStatus(engine: SyncEngine, status: 'idle' | 'syncing' | 'error'): void {
	(engine as unknown as { state: { status: 'idle' | 'syncing' | 'error' } }).state.status = status;
}

function createSyncResult(): SyncResult {
	return createEmptySyncResult();
}

function spyOnLocalChanges(
	engine: SyncEngine,
	changes: Array<{ path: string; hash: string }>,
) {
	return vi.spyOn(
		engine as unknown as { getLocalChanges(): Promise<Array<{ path: string; hash: string }>> },
		'getLocalChanges',
	).mockResolvedValue(changes);
}

function spyOnLocalDeletes(engine: SyncEngine, deletes: string[]) {
	return vi.spyOn(
		engine as unknown as { getLocalDeletes(): Promise<string[]> },
		'getLocalDeletes',
	).mockResolvedValue(deletes);
}

function spyOnIncrementalSync(engine: SyncEngine, result: SyncResult | null) {
	return vi.spyOn(
		engine as unknown as { incrementalSync(): Promise<SyncResult | null> },
		'incrementalSync',
	).mockResolvedValue(result);
}

function runProcessDiff(
	engine: SyncEngine,
	diff: FileDiff,
	localFiles: Record<string, ManifestEntry>,
	result: SyncResult,
): Promise<void> {
	return (engine as unknown as {
		processDiff(
			diffToProcess: FileDiff,
			knownLocalFiles: Record<string, ManifestEntry>,
			syncResult: SyncResult,
		): Promise<void>;
	}).processDiff(diff, localFiles, result);
}

function runConcurrentTasks<T>(
	engine: SyncEngine,
	tasks: Array<() => Promise<T>>,
	concurrency: number,
): Promise<T[]> {
	return (engine as unknown as {
		runConcurrent(taskQueue: Array<() => Promise<T>>, limit: number): Promise<T[]>;
	}).runConcurrent(tasks, concurrency);
}

function retryWithBackoff<T>(engine: SyncEngine, fn: () => Promise<T>): Promise<T> {
	return (engine as unknown as {
		retryWithBackoff(task: () => Promise<T>): Promise<T>;
	}).retryWithBackoff(fn);
}

function spyOnPrepareUploadsFromVaultFiles(
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
		cloudflareAccountId: '',
		cloudflareTokenExpiresAt: null,
		workerName: '',
		bucketName: '',
		databaseId: '',
		lastSync: null,
		lastSeq: 0,
		deviceId: 'dev-1',
		ignorePatterns: ['.trash/', '*.tmp'],
		syncOnStartup: false,
		syncInterval: 0,
		showStatusBar: true,
		syncHistory: [],
		pushEnabled: false,
	};
}

function toArrayBuffer(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function fromArrayBuffer(buffer: ArrayBuffer): string {
	return new TextDecoder().decode(new Uint8Array(buffer));
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function createHarness(settingsOverrides: Partial<CrateSettings> = {}): Harness {
	const settings = { ...createSettings(), ...settingsOverrides };

	const adapter: MockAdapter = {
		readBinary: vi.fn(),
		stat: vi.fn(),
		exists: vi.fn(),
		remove: vi.fn(),
		writeBinary: vi.fn(),
		mkdir: vi.fn(),
		list: vi.fn(),
	};

	const vault = {
		adapter,
		getAbstractFileByPath: vi.fn(),
		delete: vi.fn(),
		createFolder: vi.fn(),
		modifyBinary: vi.fn(),
		createBinary: vi.fn(),
		getFiles: vi.fn(),
	};

	const api = {
		isConfigured: vi.fn().mockReturnValue(true),
		setAbortSignal: vi.fn(),
		getChanges: vi.fn(),
		uploadFile: vi.fn(),
		deleteFile: vi.fn(),
		downloadFile: vi.fn(),
		getManifest: vi.fn(),
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

	const plugin = {
		app: { vault, fileManager },
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
		};

	setEngineLocalManifest(engine, localManifest);

	return { engine, settings, fileManager, api, vault, localManifest };
}

describe('SyncEngine pattern/ignore behavior', () => {
	let harness: Harness;

	beforeEach(() => {
		harness = createHarness();
	});

	it('matches trailing-slash patterns and wildcard patterns', () => {
		expect(matchPattern(harness.engine, '.trash', '.trash/')).toBe(true);
		expect(matchPattern(harness.engine, '.trash/file.md', '.trash/')).toBe(true);
		expect(matchPattern(harness.engine, 'notes/file.tmp', '*.tmp')).toBe(true);
		expect(matchPattern(harness.engine, 'notes/file.md', '*.tmp')).toBe(false);
	});

	it('matches slashless filename patterns against nested files', () => {
		const dsHarness = createHarness({ ignorePatterns: ['.DS_Store'] });

		expect(matchPattern(dsHarness.engine, '.DS_Store', '.DS_Store')).toBe(true);
		expect(matchPattern(dsHarness.engine, 'notes/.DS_Store', '.DS_Store')).toBe(true);
		expect(shouldIgnorePath(dsHarness.engine, 'notes/.DS_Store')).toBe(true);
		expect(shouldIgnorePath(dsHarness.engine, 'notes/keep.md')).toBe(false);
	});

	it('ignores plugin state files (data.json and file-manifest.json)', () => {
		expect(shouldIgnorePath(harness.engine, `${PLUGIN_DIR}/data.json`)).toBe(true);
		expect(shouldIgnorePath(harness.engine, `${PLUGIN_DIR}/file-manifest.json`)).toBe(true);
		expect(shouldIgnorePath(harness.engine, `${PLUGIN_DIR}/reminders-settings.json`)).toBe(true);
		// Other files in the plugin dir should not be ignored
		expect(shouldIgnorePath(harness.engine, `${PLUGIN_DIR}/main.js`)).toBe(false);
	});

	it('always ignores conflict files', () => {
		expect(
			shouldIgnorePath(harness.engine, 'notes/a (conflict 2026-01-02 03-04-05 a1b2).md'),
		).toBe(true);
		expect(shouldIgnorePath(harness.engine, 'notes/file.tmp')).toBe(true);
		expect(shouldIgnorePath(harness.engine, 'notes/file.md')).toBe(false);
	});

	it('treats regex metacharacters as literal text in patterns', () => {
		expect(matchPattern(harness.engine, 'notes[2026].md', 'notes[2026].md')).toBe(true);
		expect(matchPattern(harness.engine, 'notes2.md', 'notes[2026].md')).toBe(false);
		expect(matchPattern(harness.engine, '[', '[')).toBe(true);
	});
});

describe('SyncEngine event queue behavior', () => {
	let harness: Harness;

	beforeEach(() => {
		harness = createHarness();
		harness.vault.adapter.stat.mockResolvedValue({ type: 'file', size: 1, mtime: 1700000000000 });
	});

	it('queues remote delete when renaming from syncable path into ignored path', () => {
		const debouncedSync = spyOnDebouncedSync(harness.engine);

		harness.engine.onFileRename({ path: '.trash/note.md' } as never, 'notes/note.md');

		const pendingPaths = getPendingPaths(harness.engine);
		expect(pendingPaths.has('delete:notes/note.md')).toBe(true);
		expect(pendingPaths.has('.trash/note.md')).toBe(false);
		expect(debouncedSync).toHaveBeenCalledTimes(1);
	});

	it('queues upload when renaming from ignored path into syncable path', () => {
		const debouncedSync = spyOnDebouncedSync(harness.engine);

		harness.engine.onFileRename({ path: 'notes/note.md' } as never, '.trash/note.md');

		const pendingPaths = getPendingPaths(harness.engine);
		expect(pendingPaths.has('delete:.trash/note.md')).toBe(false);
		expect(pendingPaths.has('notes/note.md')).toBe(true);
		expect(debouncedSync).toHaveBeenCalledTimes(1);
	});

	it('ignores raw folder events', async () => {
		const debouncedSync = spyOnDebouncedSync(harness.engine);
		harness.vault.adapter.stat.mockResolvedValueOnce({ type: 'folder', size: 0, mtime: 1700000000000 });

		harness.engine.onRawFileEvent(CONFIG_PLUGINS_DIR);
		await flushMicrotasks();

		const pendingPaths = getPendingPaths(harness.engine);
		expect(pendingPaths.size).toBe(0);
		expect(debouncedSync).not.toHaveBeenCalled();
	});

	it('queues delete marker for missing tracked raw paths', async () => {
		const debouncedSync = spyOnDebouncedSync(harness.engine);
		harness.vault.adapter.stat.mockResolvedValueOnce(null);
		harness.localManifest.hasFile.mockReturnValueOnce(true);

		harness.engine.onRawFileEvent(TRACKED_PLUGIN_MAIN_PATH);
		await flushMicrotasks();

		const pendingPaths = getPendingPaths(harness.engine);
		expect(pendingPaths.has(`delete:${TRACKED_PLUGIN_MAIN_PATH}`)).toBe(true);
		expect(debouncedSync).toHaveBeenCalledTimes(1);
	});

	it('skips raw events for nested files ignored by slashless filename patterns', async () => {
		const dsHarness = createHarness({ ignorePatterns: ['.DS_Store'] });
		const debouncedSync = spyOnDebouncedSync(dsHarness.engine);
		dsHarness.vault.adapter.stat.mockResolvedValueOnce({ type: 'file', size: 1, mtime: 1700000000000 });

		dsHarness.engine.onRawFileEvent('notes/.DS_Store');
		await flushMicrotasks();

		expect(getPendingPaths(dsHarness.engine).size).toBe(0);
		expect(debouncedSync).not.toHaveBeenCalled();
	});

	it('emits idle state after flush with no pending paths left', async () => {
		const content = toArrayBuffer('A');
		harness.vault.getAbstractFileByPath.mockReturnValue({
			path: 'notes/a.md',
			extension: 'md',
			stat: { size: 1, mtime: 1700000000000 },
		});
		harness.vault.adapter.readBinary.mockResolvedValue(content);
		harness.api.uploadFile.mockResolvedValue({ success: true, path: 'notes/a.md' });

		const idlePendingCounts: number[] = [];
		harness.engine.setStateChangeCallback((state) => {
			if (state.status === 'idle') {
				idlePendingCounts.push(harness.engine.getPendingPaths().length);
			}
		});

		getPendingPaths(harness.engine).add('notes/a.md');
		await flushPendingChanges(harness.engine);

		expect(idlePendingCounts.at(-1)).toBe(0);
	});

	it('keeps new paths queued when they arrive during pending flush', async () => {
		const content = toArrayBuffer('A');
		harness.vault.getAbstractFileByPath.mockImplementation((path: string) => {
			if (path === 'notes/a.md') {
				return {
					path,
					extension: 'md',
					stat: { size: 1, mtime: 1700000000000 },
				};
			}
			return null;
		});
		harness.vault.adapter.readBinary.mockResolvedValue(content);
		const debouncedSync = spyOnDebouncedSync(harness.engine);
		harness.api.uploadFile.mockImplementation(async () => {
			getPendingPaths(harness.engine).add('notes/b.md');
			return { success: true, path: 'notes/a.md' };
		});

		getPendingPaths(harness.engine).add('notes/a.md');
		await flushPendingChanges(harness.engine);

		const pendingPaths = getPendingPaths(harness.engine);
		expect(pendingPaths.has('notes/a.md')).toBe(false);
		expect(pendingPaths.has('notes/b.md')).toBe(true);
		expect(debouncedSync).toHaveBeenCalledTimes(1);
	});

	it('re-queues pending path when upload returns success false', async () => {
		const content = toArrayBuffer('A');
		harness.vault.getAbstractFileByPath.mockReturnValue({
			path: 'notes/a.md',
			extension: 'md',
			stat: { size: 1, mtime: 1700000000000 },
		});
		harness.vault.adapter.readBinary.mockResolvedValue(content);
		spyOnDebouncedSync(harness.engine);
		harness.api.uploadFile.mockResolvedValue({
			success: false,
			path: 'notes/a.md',
			error: 'quota exceeded',
		});

		getPendingPaths(harness.engine).add('notes/a.md');
		await flushPendingChanges(harness.engine);

		const pendingPaths = getPendingPaths(harness.engine);
		expect(pendingPaths.has('notes/a.md')).toBe(true);
		expect(harness.engine.getState().status).toBe('error');
		expect(harness.engine.getState().lastError).toContain('quota exceeded');
	});
});

describe('prepareUploadFromVaultFile', () => {
	let harness: Harness;

	function transferContext(): TransferContext {
		return {
			vault: harness.vault as never,
			api: harness.api as never,
			localManifest: harness.localManifest as never,
			runConcurrent: async <T>(tasks: Array<() => Promise<T>>) => Promise.all(tasks.map(task => task())),
			retryWithBackoff: async <T>(fn: () => Promise<T>) => fn(),
			getModifiedIso: vi.fn().mockResolvedValue(new Date().toISOString()),
		};
	}

	beforeEach(() => {
		harness = createHarness();
	});

	it('skips oversized files', async () => {
		const result = await prepareUploadFromVaultFile(transferContext(), {
			path: 'big.bin',
			size: 25 * 1024 * 1024 + 1,
			mtime: Date.now(),
			extension: 'bin',
		});

		expect(result).toBeNull();
		expect(harness.vault.adapter.readBinary).not.toHaveBeenCalled();
	});

	it('skips unchanged files based on manifest hash', async () => {
		const content = new TextEncoder().encode('same').buffer as ArrayBuffer;
		harness.vault.adapter.readBinary.mockResolvedValue(content);
		harness.localManifest.hashMatches.mockReturnValue(true);

		const result = await prepareUploadFromVaultFile(transferContext(), {
			path: 'notes/same.md',
			size: 4,
			mtime: Date.now(),
			extension: 'md',
		});

		expect(result).toBeNull();
		expect(harness.localManifest.hashMatches).toHaveBeenCalled();
	});

	it('prepares files with ArrayBuffer content', async () => {
		const content = new TextEncoder().encode('hello world').buffer as ArrayBuffer;
		harness.vault.adapter.readBinary.mockResolvedValue(content);

		const result = await prepareUploadFromVaultFile(transferContext(), {
			path: 'notes/a.md',
			size: 11,
			mtime: Date.now(),
			extension: 'md',
		});

		expect(result?.path).toBe('notes/a.md');
		expect(result?.content).toBeInstanceOf(ArrayBuffer);
		expect(result?.contentType).toBe('text/markdown');
		expect(result?.hash).toHaveLength(64);
		// No 'binary' field anymore
		expect(result).not.toHaveProperty('binary');
	});

	it('prepares binary files with ArrayBuffer content', async () => {
		const bytes = new Uint8Array([0, 255, 1]);
		harness.vault.adapter.readBinary.mockResolvedValue(bytes.buffer);

		const result = await prepareUploadFromVaultFile(transferContext(), {
			path: 'images/pixel.png',
			size: 3,
			mtime: Date.now(),
			extension: 'png',
		});

		expect(result?.path).toBe('images/pixel.png');
		expect(result?.content).toBeInstanceOf(ArrayBuffer);
		expect(result?.contentType).toBe('image/png');
		// Content is raw ArrayBuffer, not base64
		expect(result!.content.byteLength).toBe(3);
		expect(result).not.toHaveProperty('binary');
	});
});

describe('SyncEngine incrementalSync', () => {
	it('returns fast success and advances lastSeq when nothing changed', async () => {
		const harness = createHarness({ lastSeq: 5 });
		harness.api.getChanges.mockResolvedValue({
			changes: [],
			lastSeq: 8,
			hasMore: false,
		});
		spyOnLocalChanges(harness.engine, []);

		const result = await runIncrementalSync(harness.engine);

		expect(result).toEqual({
			success: true,
			uploaded: 0,
			downloaded: 0,
			deleted: 0,
			conflicts: [],
			errors: [],
			uploadedPaths: [],
			downloadedPaths: [],
			deletedPaths: [],
		});
		expect(harness.settings.lastSeq).toBe(8);
		expect(harness.localManifest.save).not.toHaveBeenCalled();
	});

	it('applies remote delete changes to local state', async () => {
		const harness = createHarness({ lastSeq: 4 });
		const note = { path: 'notes/old.md' };
		harness.api.getChanges.mockResolvedValue({
			changes: [
				{
					seq: 6,
					path: 'notes/old.md',
					action: 'delete',
					hash: '',
					size: 0,
					created_at: '2026-02-06T12:00:00.000Z',
				},
			],
			lastSeq: 6,
			hasMore: false,
		});
		spyOnLocalChanges(harness.engine, []);
		spyOnLocalDeletes(harness.engine, []);
		harness.vault.getAbstractFileByPath.mockReturnValue(note);

		const result = await runIncrementalSync(harness.engine);

		expect(result?.deleted).toBe(1);
		expect(harness.fileManager.trashFile).toHaveBeenCalledWith(note);
		expect(harness.vault.delete).not.toHaveBeenCalled();
		expect(harness.vault.adapter.remove).not.toHaveBeenCalled();
		expect(harness.localManifest.removeEntry).toHaveBeenCalledWith('notes/old.md');
		expect(harness.settings.lastSeq).toBe(6);
	});

	it('hard deletes hidden files for remote delete changes', async () => {
		const harness = createHarness({ lastSeq: 4 });
		harness.api.getChanges.mockResolvedValue({
			changes: [
				{
					seq: 6,
					path: HIDDEN_WORKSPACE_PATH,
					action: 'delete',
					hash: '',
					size: 0,
					created_at: '2026-02-06T12:00:00.000Z',
				},
			],
			lastSeq: 6,
			hasMore: false,
		});
		spyOnLocalChanges(harness.engine, []);
		spyOnLocalDeletes(harness.engine, []);
		harness.vault.getAbstractFileByPath.mockReturnValue(null);
		harness.vault.adapter.exists.mockResolvedValue(true);

		const result = await runIncrementalSync(harness.engine);

		expect(result?.deleted).toBe(1);
		expect(harness.fileManager.trashFile).not.toHaveBeenCalled();
		expect(harness.vault.delete).not.toHaveBeenCalled();
		expect(harness.vault.adapter.remove).toHaveBeenCalledWith(HIDDEN_WORKSPACE_PATH);
		expect(harness.localManifest.removeEntry).toHaveBeenCalledWith(HIDDEN_WORKSPACE_PATH);
		expect(harness.settings.lastSeq).toBe(6);
	});

	it('cleans manifest state when a remote delete targets an already missing file', async () => {
		const harness = createHarness({ lastSeq: 4 });
		harness.api.getChanges.mockResolvedValue({
			changes: [
				{
					seq: 6,
					path: 'notes/missing.md',
					action: 'delete',
					hash: '',
					size: 0,
					created_at: '2026-02-06T12:00:00.000Z',
				},
			],
			lastSeq: 6,
			hasMore: false,
		});
		spyOnLocalChanges(harness.engine, []);
		spyOnLocalDeletes(harness.engine, []);
		harness.vault.getAbstractFileByPath.mockReturnValue(null);
		harness.vault.adapter.exists.mockResolvedValue(false);

		const result = await runIncrementalSync(harness.engine);

		expect(result?.deleted).toBe(0);
		expect(harness.fileManager.trashFile).not.toHaveBeenCalled();
		expect(harness.vault.delete).not.toHaveBeenCalled();
		expect(harness.vault.adapter.remove).not.toHaveBeenCalled();
		expect(harness.localManifest.removeEntry).toHaveBeenCalledWith('notes/missing.md');
		expect(harness.settings.lastSeq).toBe(6);
	});

	it('skips download when remote put hash matches local content', async () => {
		const harness = createHarness({ lastSeq: 2 });
		const content = new TextEncoder().encode('same').buffer as ArrayBuffer;
		const hash = await computeHash(content);

		harness.api.getChanges.mockResolvedValue({
			changes: [
				{
					seq: 3,
					path: 'notes/same.md',
					action: 'put',
					hash,
					size: 4,
					created_at: '2026-02-06T12:00:00.000Z',
				},
			],
				lastSeq: 3,
				hasMore: false,
			});
		spyOnLocalChanges(harness.engine, []);
		harness.vault.getAbstractFileByPath.mockReturnValue({
			path: 'notes/same.md',
			extension: 'md',
			stat: { size: 4, mtime: 1700000000000 },
		});
		harness.vault.adapter.readBinary.mockResolvedValue(content);

		const result = await runIncrementalSync(harness.engine);

		expect(result?.downloaded).toBe(0);
		expect(harness.api.downloadFile).not.toHaveBeenCalled();
		expect(harness.localManifest.setEntry).toHaveBeenCalledWith(
			'notes/same.md',
			expect.objectContaining({
				hash,
				size: 4,
			}),
		);
	});

	it('uploads local-only changes not present in remote changelog', async () => {
		const harness = createHarness({ lastSeq: 7 });
		harness.api.getChanges.mockResolvedValue({
			changes: [],
			lastSeq: 9,
			hasMore: false,
		});
		spyOnLocalChanges(harness.engine, [
			{ path: 'notes/new.md', hash: 'local-hash' },
		]);
		harness.vault.getAbstractFileByPath.mockReturnValue({
			path: 'notes/new.md',
			extension: 'md',
			stat: { size: 11, mtime: 1700000000000 },
		});
		harness.vault.adapter.readBinary.mockResolvedValue(
			new TextEncoder().encode('hello world').buffer as ArrayBuffer,
		);
		const result = await runIncrementalSync(harness.engine);

		expect(result?.uploaded).toBe(1);
		expect(harness.api.batchUpload).toHaveBeenCalledTimes(1);
		expect(harness.localManifest.setEntry).toHaveBeenCalledWith(
			'notes/new.md',
			expect.objectContaining({
				size: 11,
			}),
		);
		expect(harness.localManifest.save).toHaveBeenCalledTimes(1);
		expect(harness.settings.lastSeq).toBe(9);
	});

	it('keeps local edits when remote delete arrives and re-uploads the path', async () => {
		const harness = createHarness({ lastSeq: 10 });
		harness.api.getChanges.mockResolvedValue({
			changes: [
				{
					seq: 11,
					path: 'notes/live.md',
					action: 'delete',
					hash: '',
					size: 0,
					created_at: '2026-02-06T12:00:00.000Z',
				},
			],
			lastSeq: 11,
			hasMore: false,
		});
		spyOnLocalChanges(harness.engine, [
			{ path: 'notes/live.md', hash: 'local-hash' },
		]);
		spyOnLocalDeletes(harness.engine, []);
		harness.vault.getAbstractFileByPath.mockReturnValue({
			path: 'notes/live.md',
			extension: 'md',
			stat: { size: 9, mtime: 1700000000000 },
		});
		harness.vault.adapter.readBinary.mockResolvedValue(
			new TextEncoder().encode('keep local').buffer as ArrayBuffer,
		);

		const result = await runIncrementalSync(harness.engine);

		expect(harness.api.deleteFile).not.toHaveBeenCalled();
		expect(harness.api.batchUpload).toHaveBeenCalledTimes(1);
		expect(result?.conflicts).toContain('notes/live.md');
		expect(result?.uploaded).toBe(1);
	});

	it('propagates locally deleted files even when no remote changes exist', async () => {
		const harness = createHarness({ lastSeq: 5 });
		harness.api.getChanges.mockResolvedValue({
			changes: [],
			lastSeq: 6,
			hasMore: false,
		});
		spyOnLocalChanges(harness.engine, []);
		spyOnLocalDeletes(harness.engine, ['notes/deleted.md']);

		const result = await runIncrementalSync(harness.engine);

		expect(harness.api.batchDelete).toHaveBeenCalledWith(['notes/deleted.md']);
		expect(harness.localManifest.removeEntry).toHaveBeenCalledWith('notes/deleted.md');
		expect(result?.deleted).toBe(1);
		expect(harness.settings.lastSeq).toBe(6);
	});
});

describe('SyncEngine processDiff conflict handling', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('creates conflict copy and replaces main file with remote content', async () => {
		const harness = createHarness();
		const path = 'notes/merge.md';
		const local = 'LOCAL\nline2\nline3';
		const remote = 'line1\nline2\nREMOTE';

		const localFile = { path, extension: 'md' };
		harness.vault.getAbstractFileByPath.mockReturnValue(localFile);
		harness.vault.adapter.readBinary.mockResolvedValue(toArrayBuffer(local));
		// downloadFile now returns ArrayBuffer directly
		harness.api.downloadFile.mockResolvedValue({
			content: toArrayBuffer(remote),
			contentType: 'text/markdown',
			size: remote.length,
		});

		const localFiles: Record<string, ManifestEntry> = {};
		const result = createSyncResult();

		await runProcessDiff(
			harness.engine,
			{ path, action: 'conflict', localHash: 'l', remoteHash: 'r' },
			localFiles,
			result,
		);

		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]).toMatch(/^notes\/merge \(conflict .+\)\.md$/);
		expect(harness.api.uploadFile).not.toHaveBeenCalled();
		expect(harness.vault.modifyBinary).toHaveBeenCalledTimes(1);
		expect(harness.vault.createFolder).toHaveBeenCalledWith('notes');
		expect(harness.vault.createBinary).toHaveBeenCalledTimes(1);

		const mergedWritten = harness.vault.modifyBinary.mock.calls[0]?.[1] as ArrayBuffer;
		expect(fromArrayBuffer(mergedWritten)).toBe(remote);
		expect(localFiles[path]).toEqual(
			expect.objectContaining({
				hash: await computeHash(mergedWritten),
				size: mergedWritten.byteLength,
			}),
		);
	});

	it('creates conflict copy and remote replacement for overlapping edits', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));

		const harness = createHarness();
		const path = 'notes/conflict.md';
		const local = 'line1\nLOCAL\nline3';
		const remote = 'line1\nREMOTE\nline3';

		const localFile = { path, extension: 'md' };
		harness.vault.getAbstractFileByPath.mockReturnValue(localFile);
		harness.vault.adapter.readBinary.mockResolvedValue(toArrayBuffer(local));
		// downloadFile now returns ArrayBuffer directly
		harness.api.downloadFile.mockResolvedValue({
			content: toArrayBuffer(remote),
			contentType: 'text/markdown',
			size: remote.length,
		});

		const localFiles: Record<string, ManifestEntry> = {};
		const result = createSyncResult();

		await runProcessDiff(
			harness.engine,
			{ path, action: 'conflict', localHash: 'l', remoteHash: 'r' },
			localFiles,
			result,
		);

		expect(harness.api.uploadFile).not.toHaveBeenCalled();
		expect(harness.vault.createFolder).toHaveBeenCalledWith('notes');
		expect(harness.vault.createBinary).toHaveBeenCalledWith(
			expect.stringMatching(/^notes\/conflict \(conflict 2026-01-02 03-04-05 [a-z0-9]{4}\)\.md$/),
			expect.any(ArrayBuffer),
		);
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0]).toMatch(/^notes\/conflict \(conflict 2026-01-02 03-04-05 [a-z0-9]{4}\)\.md$/);

		const mainWritten = harness.vault.modifyBinary.mock.calls[0]?.[1] as ArrayBuffer;
		expect(fromArrayBuffer(mainWritten)).toBe(remote);
		expect(localFiles[path]).toEqual(
			expect.objectContaining({
				hash: await computeHash(mainWritten),
				size: mainWritten.byteLength,
			}),
		);
	});
});

describe('SyncEngine incremental sync cursor/state safeguards', () => {
	it('does not advance lastSeq when incremental sync has per-file errors', async () => {
		const harness = createHarness({ lastSeq: 1 });
		harness.api.getChanges.mockResolvedValue({
			changes: [
				{
					seq: 2,
					path: 'notes/remote.md',
					action: 'put',
					hash: 'remote-hash',
					size: 10,
					created_at: '2026-02-06T12:00:00.000Z',
				},
			],
			lastSeq: 2,
			hasMore: false,
		});
		spyOnLocalChanges(harness.engine, []);
		spyOnLocalDeletes(harness.engine, []);
		harness.vault.getAbstractFileByPath.mockReturnValue(null);
		harness.api.batchDownload.mockRejectedValue(new Error('network down'));
		harness.api.downloadFile.mockRejectedValue(new Error('network down'));

		const result = await runIncrementalSync(harness.engine);

		expect(result?.success).toBe(false);
		expect(result?.errors).toContain('notes/remote.md: network down');
		expect(harness.settings.lastSeq).toBe(1);
	});

	it('sets state to error when incremental sync returns errors', async () => {
		const harness = createHarness({ lastSeq: 1 });
		harness.api.getChanges.mockResolvedValue({
			changes: [
				{
					seq: 2,
					path: 'notes/remote.md',
					action: 'put',
					hash: 'remote-hash',
					size: 10,
					created_at: '2026-02-06T12:00:00.000Z',
				},
			],
			lastSeq: 2,
			hasMore: false,
		});
		spyOnLocalChanges(harness.engine, []);
		spyOnLocalDeletes(harness.engine, []);
		harness.vault.getAbstractFileByPath.mockReturnValue(null);
		harness.api.batchDownload.mockRejectedValue(new Error('network down'));
		harness.api.downloadFile.mockRejectedValue(new Error('network down'));

		const result = await harness.engine.sync();
		const state = harness.engine.getState();

		expect(result.success).toBe(false);
		expect(state.status).toBe('error');
		expect(state.lastError).toBe('notes/remote.md: network down');
	});
});

describe('SyncEngine full sync safeguards', () => {
	it('skips ignored remote paths during full sync reconciliation', async () => {
		const harness = createHarness({ lastSeq: 0 });
		harness.api.getManifest.mockResolvedValue({
			version: 1,
			files: {
				'.trash/remote.md': {
					hash: 'remote-hash',
					size: 10,
					modified: '2026-02-06T12:00:00.000Z',
				},
			},
			lastSeq: 3,
		});
		harness.vault.getFiles.mockReturnValue([]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: ['.trash'] });

		const result = await harness.engine.sync();

		expect(result.success).toBe(true);
		expect(result.downloaded).toBe(0);
		expect(harness.api.downloadFile).not.toHaveBeenCalled();
	});

	it('does not advance lastSeq when full sync has non-fatal errors', async () => {
		const harness = createHarness({ lastSeq: 5 });
		spyOnIncrementalSync(harness.engine, null);
		harness.api.getManifest.mockResolvedValue({
			version: 1,
			files: {
				'notes/big.bin': {
					hash: 'remote-big',
					size: MAX_FILE_SIZE_BYTES + 1,
					modified: '2026-02-06T12:00:00.000Z',
				},
			},
			lastSeq: 9,
		});
		harness.vault.getFiles.mockReturnValue([]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });

		const result = await harness.engine.sync();

		expect(result.success).toBe(false);
		expect(result.errors).toContain('notes/big.bin: Skipped remote file larger than 25MB');
		expect(harness.settings.lastSeq).toBe(5);
	});
});

describe('SyncEngine slice 5 safeguards', () => {
	it('rejects initial sync while another sync is in progress', async () => {
		const harness = createHarness();
		setSyncStatus(harness.engine, 'syncing');

		const result = await harness.engine.initialSync();

		expect(result.success).toBe(false);
		expect(result.errors).toEqual(['Sync already in progress']);
		expect(harness.vault.getFiles).not.toHaveBeenCalled();
	});

	it('sets state to error when initial sync finishes with per-file errors', async () => {
		const harness = createHarness();
		const file = {
			path: 'notes/a.md',
			extension: 'md',
			stat: { size: 1, mtime: 1700000000000 },
		};
		harness.vault.getFiles.mockReturnValue([file]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		harness.vault.adapter.readBinary.mockResolvedValue(toArrayBuffer('A'));
		harness.api.batchUpload.mockResolvedValue({
			success: false,
			results: [{ path: 'notes/a.md', success: false, error: 'quota exceeded' }],
		});

		const result = await harness.engine.initialSync();
		const state = harness.engine.getState();

		expect(result.success).toBe(false);
		expect(result.errors).toContain('notes/a.md: quota exceeded');
		expect(state.status).toBe('error');
		expect(state.lastError).toBe('notes/a.md: quota exceeded');
		expect(harness.settings.lastSync).toBeNull();
	});

	it('reuses discovered mtimes during initial sync uploads', async () => {
		const harness = createHarness();
		const mtime = 1700000000000;
		const file = {
			path: 'notes/a.md',
			extension: 'md',
			stat: { size: 1, mtime },
		};
		harness.vault.getFiles.mockReturnValue([file]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		harness.vault.adapter.readBinary.mockResolvedValue(toArrayBuffer('A'));
		harness.vault.adapter.stat.mockResolvedValue({ type: 'file', size: 1, mtime: mtime + 5000 });

		const result = await harness.engine.initialSync();

		expect(result.success).toBe(true);
		expect(harness.vault.adapter.stat).not.toHaveBeenCalled();
		expect(harness.localManifest.setEntry).toHaveBeenCalledWith(
			'notes/a.md',
			expect.objectContaining({ modified: new Date(mtime).toISOString() }),
		);
	});

	it('sets state to error when force full sync finishes with non-fatal errors', async () => {
		const harness = createHarness();
		harness.api.getManifest.mockResolvedValue({
			version: 1,
			files: {
				'notes/remote-only.md': {
					hash: 'remote-hash',
					size: 3,
					modified: '2026-02-06T12:00:00.000Z',
				},
			},
		});
		harness.vault.getFiles.mockReturnValue([]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		harness.api.deleteFile.mockRejectedValue(new Error('remote locked'));

		const result = await harness.engine.forceFullSync();
		const state = harness.engine.getState();

		expect(result.success).toBe(false);
		expect(result.errors).toContain('delete notes/remote-only.md: remote locked');
		expect(state.status).toBe('error');
		expect(state.lastError).toBe('delete notes/remote-only.md: remote locked');
		expect(harness.settings.lastSync).toBeNull();
	});

	it('does not delete ignored remote-only paths during force full sync', async () => {
		const harness = createHarness();
		harness.api.getManifest.mockResolvedValue({
			version: 1,
			files: {
				'.trash/old.md': {
					hash: 'ignored-hash',
					size: 10,
					modified: '2026-02-06T12:00:00.000Z',
				},
				'notes/remote-only.md': {
					hash: 'remote-hash',
					size: 3,
					modified: '2026-02-06T12:00:00.000Z',
				},
			},
		});
		harness.vault.getFiles.mockReturnValue([]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		harness.api.deleteFile.mockResolvedValue({ success: true, path: 'notes/remote-only.md' });

		const result = await harness.engine.forceFullSync();

		expect(result.success).toBe(true);
		expect(result.deleted).toBe(1);
		expect(harness.api.deleteFile).toHaveBeenCalledTimes(1);
		expect(harness.api.deleteFile).toHaveBeenCalledWith('notes/remote-only.md');
		expect(harness.api.deleteFile).not.toHaveBeenCalledWith('.trash/old.md');
	});

	it('does not reschedule debounced sync after destroy during a pending flush', async () => {
		const harness = createHarness();
		const content = toArrayBuffer('A');
		let releaseUpload!: () => void;
		let signalUploadStarted!: () => void;
		const uploadGate = new Promise<void>(resolve => {
			releaseUpload = () => resolve();
		});
		const uploadStarted = new Promise<void>(resolve => {
			signalUploadStarted = () => resolve();
		});

		harness.vault.getAbstractFileByPath.mockImplementation((path: string) => {
			if (path === 'notes/a.md') {
				return {
					path,
					extension: 'md',
					stat: { size: 1, mtime: 1700000000000 },
				};
			}
			return null;
		});
		harness.vault.adapter.readBinary.mockResolvedValue(content);
		harness.api.uploadFile.mockImplementation(async () => {
			signalUploadStarted();
			getPendingPaths(harness.engine).add('notes/b.md');
			await uploadGate;
			return { success: true, path: 'notes/a.md' };
		});
		const debouncedSync = spyOnDebouncedSync(harness.engine);

		getPendingPaths(harness.engine).add('notes/a.md');
		const processing = flushPendingChanges(harness.engine);
		await uploadStarted;

		harness.engine.destroy();
		releaseUpload();
		await processing;

		expect(debouncedSync).not.toHaveBeenCalled();
		expect(getPendingPaths(harness.engine).size).toBe(0);
	});
});

describe('SyncEngine abort-on-destroy', () => {
	it('does not advance lastSeq when incremental sync is aborted', async () => {
		const harness = createHarness({ lastSeq: 5 });
		harness.api.getChanges.mockResolvedValue({
			changes: [
				{
					seq: 8,
					path: 'notes/remote.md',
					action: 'put',
					hash: 'remote-hash',
					size: 10,
					created_at: '2026-02-06T12:00:00.000Z',
				},
			],
			lastSeq: 8,
			hasMore: false,
		});
		spyOnLocalChanges(harness.engine, []);
		spyOnLocalDeletes(harness.engine, []);
		harness.vault.getAbstractFileByPath.mockReturnValue(null);
		// batchDownload throws AbortError (simulating destroy during download)
		harness.api.batchDownload.mockRejectedValue(
			new DOMException('signal is aborted without reason', 'AbortError'),
		);

		const result = await harness.engine.sync();

		expect(result.errors).toHaveLength(0);
		expect(harness.settings.lastSeq).toBe(5);
		expect(harness.engine.getState().status).not.toBe('error');
	});

	it('aborts in-flight sync when destroyed and does not set error state', async () => {
		const harness = createHarness({ lastSeq: 0 });
		// Make incremental sync fall through to full sync
		spyOnIncrementalSync(harness.engine, null);
		// getManifest will hang until we signal it
		let rejectManifest!: (error: Error) => void;
		const manifestCalled = new Promise<void>(resolve => {
			harness.api.getManifest.mockImplementation(() => new Promise((_res, rej) => {
				rejectManifest = rej;
				resolve();
			}));
		});

		const syncPromise = harness.engine.sync();
		await manifestCalled;

		// Destroy mid-flight - this aborts the controller
		harness.engine.destroy();
		// Simulate the fetch abort that would happen
		rejectManifest(new DOMException('The operation was aborted', 'AbortError'));

		const result = await syncPromise;

		// Should not have set error state (abort is not an error)
		expect(result.errors).toHaveLength(0);
		expect(harness.engine.getState().status).not.toBe('error');
	});

	it('stops launching new concurrent tasks after destroy', async () => {
		const harness = createHarness();
		const callOrder: number[] = [];

		const tasks = [
			async () => { callOrder.push(1); return 1; },
			async () => {
				callOrder.push(2);
				harness.engine.destroy();
				return 2;
			},
			async () => { callOrder.push(3); return 3; },
			async () => { callOrder.push(4); return 4; },
		];

		await runConcurrentTasks(harness.engine, tasks, 1);

		// Task 3 and 4 should not run because destroy was called during task 2
		expect(callOrder).toEqual([1, 2]);
	});

	it('retryWithBackoff does not retry after destroy', async () => {
		const harness = createHarness();
		let callCount = 0;

		const fn = async () => {
			callCount++;
			if (callCount === 1) {
				harness.engine.destroy();
				throw new Error('first failure');
			}
			return 'done';
		};

		await expect(
			retryWithBackoff(harness.engine, fn),
		).rejects.toThrow('first failure');

		expect(callCount).toBe(1);
	});

	it('initialSync aborts cleanly when destroyed during chunk processing', async () => {
		const harness = createHarness();
		const file = {
			path: 'notes/a.md',
			extension: 'md',
			stat: { size: 1, mtime: 1700000000000 },
		};
		harness.vault.getFiles.mockReturnValue([file]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		harness.vault.adapter.readBinary.mockResolvedValue(toArrayBuffer('A'));

		// Destroy during prepare phase
		spyOnPrepareUploadsFromVaultFiles(harness.engine, async () => {
			harness.engine.destroy();
			return [{ path: 'notes/a.md', content: toArrayBuffer('A'), hash: 'h', size: 1 }];
		});

		const result = await harness.engine.initialSync();

		// Should not have set error state
		expect(result.errors).toHaveLength(0);
		expect(harness.engine.getState().status).not.toBe('error');
	});

	it('forceFullSync aborts cleanly when destroyed after prepare', async () => {
		const harness = createHarness();
		harness.api.getManifest.mockResolvedValue({ version: 1, files: {} });
		harness.vault.getFiles.mockReturnValue([]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });

		// Destroy after prepareUploadsFromVaultFiles
		spyOnPrepareUploadsFromVaultFiles(harness.engine, async () => {
			harness.engine.destroy();
			return [];
		});

		const result = await harness.engine.forceFullSync();

		expect(result.errors).toHaveLength(0);
		expect(harness.engine.getState().status).not.toBe('error');
	});
});
