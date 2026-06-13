import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncEngine } from './engine';
import type { SyncQueueController } from './queue-controller';
import { createEmptySyncResult } from './sync-result';
import type { CrateSettings, FileManifest, PreparedUpload, SyncResult, UploadResult } from '../plugin/types';
import { MAX_FILE_SIZE_BYTES } from '../plugin/types';

const CONFIG_DIR = '.vault-config';
const PLUGIN_DIR = `${CONFIG_DIR}/plugins/obsidian-crate`;
const CONFIG_PLUGINS_DIR = `${CONFIG_DIR}/plugins`;
const TRACKED_PLUGIN_MAIN_PATH = `${CONFIG_DIR}/plugins/foo/main.js`;

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

function setEngineLocalManifest(
	engine: SyncEngine,
	localManifest: Harness['localManifest'],
): void {
	(engine as unknown as { localManifest: Harness['localManifest'] }).localManifest = localManifest;
}

function getQueueController(engine: SyncEngine): SyncQueueController {
	return (engine as unknown as { queueController: SyncQueueController }).queueController;
}

function getPendingPaths(engine: SyncEngine): Set<string> {
	return (getQueueController(engine) as unknown as { pendingPaths: Set<string> }).pendingPaths;
}

function spyOnDebouncedSync(engine: SyncEngine) {
	return vi
		.spyOn(getQueueController(engine) as unknown as { debouncedSync(): void }, 'debouncedSync')
		.mockImplementation(() => {});
}

async function flushPendingChanges(engine: SyncEngine): Promise<void> {
	await (getQueueController(engine) as unknown as { processPendingChanges(): Promise<void> }).processPendingChanges();
}

function setSyncStatus(engine: SyncEngine, status: 'idle' | 'syncing' | 'error'): void {
	(engine as unknown as { state: { status: 'idle' | 'syncing' | 'error' } }).state.status = status;
}

function getConsecutiveCheckFailures(engine: SyncEngine): number {
	return (engine as unknown as { consecutiveCheckFailures: number }).consecutiveCheckFailures;
}

async function runPeriodicCheck(engine: SyncEngine): Promise<void> {
	await (engine as unknown as { periodicCheck(): Promise<void> }).periodicCheck();
}

function createSyncResult(): SyncResult {
	return createEmptySyncResult();
}

function spyOnIncrementalSync(engine: SyncEngine, result: SyncResult | null) {
	return vi.spyOn(
		engine as unknown as { incrementalSync(): Promise<SyncResult | null> },
		'incrementalSync',
	).mockResolvedValue(result);
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
		workerName: '',
		bucketName: '',
		databaseId: '',
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

function toArrayBuffer(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer as ArrayBuffer;
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

describe('SyncEngine explicit sync queue reconciliation', () => {
	it('clears queued paths that were handled by an explicit sync result', async () => {
		const harness = createHarness();
		const result = createSyncResult();
		result.uploaded = 1;
		result.downloaded = 1;
		result.deleted = 1;
		result.uploadedPaths.push('notes/uploaded.md');
		result.downloadedPaths.push('notes/downloaded.md');
		result.deletedPaths.push('notes/deleted.md');
		spyOnIncrementalSync(harness.engine, result);

		const pendingPaths = getPendingPaths(harness.engine);
		pendingPaths.add('notes/uploaded.md');
		pendingPaths.add('notes/downloaded.md');
		pendingPaths.add('delete:notes/deleted.md');
		pendingPaths.add('notes/still-pending.md');

		const syncResult = await harness.engine.sync();

		expect(syncResult).toBe(result);
		expect(pendingPaths.has('notes/uploaded.md')).toBe(false);
		expect(pendingPaths.has('notes/downloaded.md')).toBe(false);
		expect(pendingPaths.has('delete:notes/deleted.md')).toBe(false);
		expect(pendingPaths.has('notes/still-pending.md')).toBe(true);
		expect(harness.engine.getState().pendingChanges).toBe(1);
	});

	it('clears pending state immediately when explicit sync handled all queued paths', async () => {
		const harness = createHarness();
		const result = createSyncResult();
		result.uploaded = 1;
		result.uploadedPaths.push('notes/a.md');
		spyOnIncrementalSync(harness.engine, result);

		const pendingPaths = getPendingPaths(harness.engine);
		pendingPaths.add('notes/a.md');

		await harness.engine.sync();

		expect(pendingPaths.size).toBe(0);
		expect(harness.engine.getPendingPaths()).toEqual([]);
		expect(harness.engine.getState().pendingChanges).toBe(0);
	});
});

describe('SyncEngine incremental sync cursor/state safeguards', () => {
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
		harness.vault.getFiles.mockReturnValue([]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
		harness.vault.getAbstractFileByPath.mockReturnValue(null);
		harness.api.batchDownload.mockRejectedValue(new Error('network down'));
		harness.api.downloadFile.mockRejectedValue(new Error('network down'));

		const result = await harness.engine.sync();
		const state = harness.engine.getState();

		expect(result.success).toBe(false);
		expect(state.status).toBe('error');
		expect(state.lastError).toBe('notes/remote.md: network down');
		expect(harness.settings.lastSeq).toBe(1);
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
		harness.vault.getFiles.mockReturnValue([]);
		harness.vault.adapter.list.mockResolvedValue({ files: [], folders: [] });
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

describe('SyncEngine periodic check backoff', () => {
	it('resets backoff on updateSettings', async () => {
		const harness = createHarness({ syncInterval: 60 });
		setEngineLocalManifest(harness.engine, harness.localManifest);
		harness.api.checkForChanges.mockRejectedValue(new Error('network error'));

		await runPeriodicCheck(harness.engine);
		expect(getConsecutiveCheckFailures(harness.engine)).toBe(1);

		harness.engine.updateSettings({ ...harness.settings, syncInterval: 60 });
		expect(getConsecutiveCheckFailures(harness.engine)).toBe(0);
	});
});
