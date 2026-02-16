import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncEngine } from './engine';
import { computeHash } from './hasher';
import { prepareUploadFromVaultFile } from './transfer';
import type { CrateSettings } from '../types';
import { MAX_FILE_SIZE_BYTES } from '../types';

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
		getEntry: ReturnType<typeof vi.fn>;
		getAllPaths: ReturnType<typeof vi.fn>;
		getManifest: ReturnType<typeof vi.fn>;
		setEntry: ReturnType<typeof vi.fn>;
		removeEntry: ReturnType<typeof vi.fn>;
		clear: ReturnType<typeof vi.fn>;
	};
};

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
	};
}

function toArrayBuffer(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function fromArrayBuffer(buffer: ArrayBuffer): string {
	return new TextDecoder().decode(new Uint8Array(buffer));
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

	const plugin = {
		app: { vault },
		manifest: { dir: '.obsidian/plugins/obsidian-crate' },
	};

	const engine = new SyncEngine(plugin as never, api as never, settings);

	const manifestFiles: Record<string, { hash: string; size: number; modified: string }> = {};
	const localManifest = {
		load: vi.fn(),
		save: vi.fn(),
		hashMatches: vi.fn((path: string, hash: string) => manifestFiles[path]?.hash === hash),
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

	(engine as any).localManifest = localManifest;

	return { engine, settings, api, vault, localManifest };
}

describe('SyncEngine pattern/ignore behavior', () => {
	let harness: Harness;

	beforeEach(() => {
		harness = createHarness();
	});

	it('matches trailing-slash patterns and wildcard patterns', () => {
		expect((harness.engine as any).matchPattern('.trash', '.trash/')).toBe(true);
		expect((harness.engine as any).matchPattern('.trash/file.md', '.trash/')).toBe(true);
		expect((harness.engine as any).matchPattern('notes/file.tmp', '*.tmp')).toBe(true);
		expect((harness.engine as any).matchPattern('notes/file.md', '*.tmp')).toBe(false);
	});

	it('ignores plugin state files (data.json and file-manifest.json)', () => {
		const shouldIgnore = (harness.engine as any).shouldIgnore.bind(harness.engine);
		expect(shouldIgnore('.obsidian/plugins/obsidian-crate/data.json')).toBe(true);
		expect(shouldIgnore('.obsidian/plugins/obsidian-crate/file-manifest.json')).toBe(true);
		// Other files in the plugin dir should not be ignored
		expect(shouldIgnore('.obsidian/plugins/obsidian-crate/main.js')).toBe(false);
	});

	it('always ignores conflict files', () => {
		expect(
			(harness.engine as any).shouldIgnore('notes/a (conflict 2026-01-02 03-04-05 a1b2).md'),
		).toBe(true);
		expect((harness.engine as any).shouldIgnore('notes/file.tmp')).toBe(true);
		expect((harness.engine as any).shouldIgnore('notes/file.md')).toBe(false);
	});

	it('treats regex metacharacters as literal text in patterns', () => {
		expect((harness.engine as any).matchPattern('notes[2026].md', 'notes[2026].md')).toBe(true);
		expect((harness.engine as any).matchPattern('notes2.md', 'notes[2026].md')).toBe(false);
		expect((harness.engine as any).matchPattern('[', '[')).toBe(true);
	});
});

describe('SyncEngine event queue behavior', () => {
	let harness: Harness;

	beforeEach(() => {
		harness = createHarness();
		harness.vault.adapter.stat.mockResolvedValue({ type: 'file', size: 1, mtime: 1700000000000 });
	});

	it('queues remote delete when renaming from syncable path into ignored path', () => {
		const debouncedSync = vi
			.spyOn(harness.engine as any, 'debouncedSync')
			.mockImplementation(() => {});

		harness.engine.onFileRename({ path: '.trash/note.md' } as never, 'notes/note.md');

		const pendingPaths = (harness.engine as any).pendingPaths as Set<string>;
		expect(pendingPaths.has('delete:notes/note.md')).toBe(true);
		expect(pendingPaths.has('.trash/note.md')).toBe(false);
		expect(debouncedSync).toHaveBeenCalledTimes(1);
	});

	it('queues upload when renaming from ignored path into syncable path', () => {
		const debouncedSync = vi
			.spyOn(harness.engine as any, 'debouncedSync')
			.mockImplementation(() => {});

		harness.engine.onFileRename({ path: 'notes/note.md' } as never, '.trash/note.md');

		const pendingPaths = (harness.engine as any).pendingPaths as Set<string>;
		expect(pendingPaths.has('delete:.trash/note.md')).toBe(false);
		expect(pendingPaths.has('notes/note.md')).toBe(true);
		expect(debouncedSync).toHaveBeenCalledTimes(1);
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
		const debouncedSync = vi
			.spyOn(harness.engine as any, 'debouncedSync')
			.mockImplementation(() => {});
		harness.api.uploadFile.mockImplementation(async () => {
			(harness.engine as any).pendingPaths.add('notes/b.md');
			return { success: true, path: 'notes/a.md' };
		});

		(harness.engine as any).pendingPaths.add('notes/a.md');
		await (harness.engine as any).processPendingChanges();

		const pendingPaths = (harness.engine as any).pendingPaths as Set<string>;
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
		vi.spyOn(harness.engine as any, 'debouncedSync').mockImplementation(() => {});
		harness.api.uploadFile.mockResolvedValue({
			success: false,
			path: 'notes/a.md',
			error: 'quota exceeded',
		});

		(harness.engine as any).pendingPaths.add('notes/a.md');
		await (harness.engine as any).processPendingChanges();

		const pendingPaths = (harness.engine as any).pendingPaths as Set<string>;
		expect(pendingPaths.has('notes/a.md')).toBe(true);
		expect(harness.engine.getState().status).toBe('error');
		expect(harness.engine.getState().lastError).toContain('quota exceeded');
	});
});

describe('prepareUploadFromVaultFile', () => {
	let harness: Harness;

	function transferContext() {
		return {
			vault: harness.vault as any,
			api: harness.api as any,
			localManifest: harness.localManifest as any,
			runConcurrent: vi.fn(),
			retryWithBackoff: vi.fn(),
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

		expect(result).toEqual(
			expect.objectContaining({
				path: 'notes/a.md',
				content: expect.any(ArrayBuffer),
				contentType: 'text/markdown',
			}),
		);
		expect(result?.hash).toHaveLength(64);
		// No 'binary' field anymore
		expect(result).not.toHaveProperty('binary');
	});

	it('prepares binary files with ArrayBuffer content', async () => {
		const bytes = new Uint8Array([0, 255, 1]);
		harness.vault.adapter.readBinary.mockResolvedValue(bytes.buffer as ArrayBuffer);

		const result = await prepareUploadFromVaultFile(transferContext(), {
			path: 'images/pixel.png',
			size: 3,
			mtime: Date.now(),
			extension: 'png',
		});

		expect(result).toEqual(
			expect.objectContaining({
				path: 'images/pixel.png',
				content: expect.any(ArrayBuffer),
				contentType: 'image/png',
			}),
		);
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
		vi.spyOn(harness.engine as any, 'getLocalChanges').mockResolvedValue([]);

		const result = await (harness.engine as any).incrementalSync();

		expect(result).toEqual({
			success: true,
			uploaded: 0,
			downloaded: 0,
			deleted: 0,
			conflicts: [],
			errors: [],
		});
		expect(harness.settings.lastSeq).toBe(8);
		expect(harness.localManifest.save).not.toHaveBeenCalled();
	});

	it('applies remote delete changes to local state', async () => {
		const harness = createHarness({ lastSeq: 4 });
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
		vi.spyOn(harness.engine as any, 'getLocalChanges').mockResolvedValue([]);
		harness.vault.getAbstractFileByPath.mockReturnValue({ path: 'notes/old.md' });

		const result = await (harness.engine as any).incrementalSync();

		expect(result?.deleted).toBe(1);
		expect(harness.vault.delete).toHaveBeenCalledWith({ path: 'notes/old.md' });
		expect(harness.localManifest.removeEntry).toHaveBeenCalledWith('notes/old.md');
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
		vi.spyOn(harness.engine as any, 'getLocalChanges').mockResolvedValue([]);
		harness.vault.getAbstractFileByPath.mockReturnValue({
			path: 'notes/same.md',
			extension: 'md',
			stat: { size: 4, mtime: 1700000000000 },
		});
		harness.vault.adapter.readBinary.mockResolvedValue(content);

		const result = await (harness.engine as any).incrementalSync();

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
		vi.spyOn(harness.engine as any, 'getLocalChanges').mockResolvedValue([
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
		const result = await (harness.engine as any).incrementalSync();

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
		vi.spyOn(harness.engine as any, 'getLocalChanges').mockResolvedValue([
			{ path: 'notes/live.md', hash: 'local-hash' },
		]);
		vi.spyOn(harness.engine as any, 'getLocalDeletes').mockResolvedValue([]);
		harness.vault.getAbstractFileByPath.mockReturnValue({
			path: 'notes/live.md',
			extension: 'md',
			stat: { size: 9, mtime: 1700000000000 },
		});
		harness.vault.adapter.readBinary.mockResolvedValue(
			new TextEncoder().encode('keep local').buffer as ArrayBuffer,
		);

		const result = await (harness.engine as any).incrementalSync();

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
		vi.spyOn(harness.engine as any, 'getLocalChanges').mockResolvedValue([]);
		vi.spyOn(harness.engine as any, 'getLocalDeletes').mockResolvedValue(['notes/deleted.md']);

		const result = await (harness.engine as any).incrementalSync();

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

		const localFiles: Record<string, { hash: string; size: number; modified: string }> = {};
		const result = {
			success: true,
			uploaded: 0,
			downloaded: 0,
			deleted: 0,
			conflicts: [] as string[],
			errors: [] as string[],
		};

		await (harness.engine as any).processDiff(
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

		const localFiles: Record<string, { hash: string; size: number; modified: string }> = {};
		const result = {
			success: true,
			uploaded: 0,
			downloaded: 0,
			deleted: 0,
			conflicts: [] as string[],
			errors: [] as string[],
		};

		await (harness.engine as any).processDiff(
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
		vi.spyOn(harness.engine as any, 'getLocalChanges').mockResolvedValue([]);
		vi.spyOn(harness.engine as any, 'getLocalDeletes').mockResolvedValue([]);
		harness.vault.getAbstractFileByPath.mockReturnValue(null);
		harness.api.batchDownload.mockRejectedValue(new Error('network down'));
		harness.api.downloadFile.mockRejectedValue(new Error('network down'));

		const result = await (harness.engine as any).incrementalSync();

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
		vi.spyOn(harness.engine as any, 'getLocalChanges').mockResolvedValue([]);
		vi.spyOn(harness.engine as any, 'getLocalDeletes').mockResolvedValue([]);
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
		vi.spyOn(harness.engine as any, 'incrementalSync').mockResolvedValue(null);
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
		(harness.engine as any).state.status = 'syncing';

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
			(harness.engine as any).pendingPaths.add('notes/b.md');
			await uploadGate;
			return { success: true, path: 'notes/a.md' };
		});
		const debouncedSync = vi
			.spyOn(harness.engine as any, 'debouncedSync')
			.mockImplementation(() => {});

		(harness.engine as any).pendingPaths.add('notes/a.md');
		const processing = (harness.engine as any).processPendingChanges();
		await uploadStarted;

		harness.engine.destroy();
		releaseUpload();
		await processing;

		expect(debouncedSync).not.toHaveBeenCalled();
		expect((harness.engine as any).pendingPaths.size).toBe(0);
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
		vi.spyOn(harness.engine as any, 'getLocalChanges').mockResolvedValue([]);
		vi.spyOn(harness.engine as any, 'getLocalDeletes').mockResolvedValue([]);
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
		vi.spyOn(harness.engine as any, 'incrementalSync').mockResolvedValue(null);
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

		await (harness.engine as any).runConcurrent(tasks, 1);

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
			(harness.engine as any).retryWithBackoff(fn),
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
		vi.spyOn(harness.engine as any, 'prepareUploadsFromVaultFiles').mockImplementation(async () => {
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
		vi.spyOn(harness.engine as any, 'prepareUploadsFromVaultFiles').mockImplementation(async () => {
			harness.engine.destroy();
			return [];
		});

		const result = await harness.engine.forceFullSync();

		expect(result.errors).toHaveLength(0);
		expect(harness.engine.getState().status).not.toBe('error');
	});
});
