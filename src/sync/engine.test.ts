import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncEngine } from './engine';
import { computeHash } from './hasher';
import type { CrateSettings } from '../types';

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
		getChanges: ReturnType<typeof vi.fn>;
		uploadFiles: ReturnType<typeof vi.fn>;
		deleteFile: ReturnType<typeof vi.fn>;
		downloadFile: ReturnType<typeof vi.fn>;
		getManifest: ReturnType<typeof vi.fn>;
		getTombstones: ReturnType<typeof vi.fn>;
		checkForChanges: ReturnType<typeof vi.fn>;
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
		getChanges: vi.fn(),
		uploadFiles: vi.fn(),
		deleteFile: vi.fn(),
		downloadFile: vi.fn(),
		getManifest: vi.fn(),
		getTombstones: vi.fn(),
		checkForChanges: vi.fn(),
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

	it('always ignores conflict files', () => {
		expect(
			(harness.engine as any).shouldIgnore('notes/a (conflict 2026-01-02 03-04).md'),
		).toBe(true);
		expect((harness.engine as any).shouldIgnore('notes/file.tmp')).toBe(true);
		expect((harness.engine as any).shouldIgnore('notes/file.md')).toBe(false);
	});
});

describe('SyncEngine prepareUploadFromVaultFile', () => {
	let harness: Harness;

	beforeEach(() => {
		harness = createHarness();
	});

	it('skips oversized files', async () => {
		const result = await (harness.engine as any).prepareUploadFromVaultFile({
			path: 'big.bin',
			size: 5 * 1024 * 1024 + 1,
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

		const result = await (harness.engine as any).prepareUploadFromVaultFile({
			path: 'notes/same.md',
			size: 4,
			mtime: Date.now(),
			extension: 'md',
		});

		expect(result).toBeNull();
		expect(harness.localManifest.hashMatches).toHaveBeenCalled();
	});

	it('prepares text files without base64 encoding', async () => {
		const content = new TextEncoder().encode('hello world').buffer as ArrayBuffer;
		harness.vault.adapter.readBinary.mockResolvedValue(content);

		const result = await (harness.engine as any).prepareUploadFromVaultFile({
			path: 'notes/a.md',
			size: 11,
			mtime: Date.now(),
			extension: 'md',
		});

		expect(result).toEqual(
			expect.objectContaining({
				path: 'notes/a.md',
				content: 'hello world',
				binary: false,
				contentType: 'text/markdown',
			}),
		);
		expect(result?.hash).toHaveLength(64);
	});

	it('prepares binary files using base64 encoding', async () => {
		const bytes = new Uint8Array([0, 255, 1]);
		harness.vault.adapter.readBinary.mockResolvedValue(bytes.buffer as ArrayBuffer);

		const result = await (harness.engine as any).prepareUploadFromVaultFile({
			path: 'images/pixel.png',
			size: 3,
			mtime: Date.now(),
			extension: 'png',
		});

		expect(result).toEqual(
			expect.objectContaining({
				path: 'images/pixel.png',
				content: Buffer.from(bytes).toString('base64'),
				binary: true,
				contentType: 'image/png',
			}),
		);
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
		harness.api.uploadFiles.mockResolvedValue({
			success: true,
			results: [{ path: 'notes/new.md', success: true }],
		});

		const result = await (harness.engine as any).incrementalSync();

		expect(result?.uploaded).toBe(1);
		expect(harness.api.uploadFiles).toHaveBeenCalledTimes(1);
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
		harness.api.uploadFiles.mockResolvedValue({
			success: true,
			results: [{ path: 'notes/live.md', success: true }],
		});

		const result = await (harness.engine as any).incrementalSync();

		expect(harness.api.deleteFile).not.toHaveBeenCalled();
		expect(harness.api.uploadFiles).toHaveBeenCalledTimes(1);
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
		harness.api.deleteFile.mockResolvedValue({ success: true, path: 'notes/deleted.md' });

		const result = await (harness.engine as any).incrementalSync();

		expect(harness.api.deleteFile).toHaveBeenCalledWith('notes/deleted.md');
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
		harness.api.downloadFile.mockResolvedValue({
			path,
			content: Buffer.from(remote).toString('base64'),
			contentType: 'text/markdown',
			size: remote.length,
		});
		harness.api.uploadFiles.mockResolvedValue({
			success: true,
			results: [{ path, success: true }],
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
		expect(harness.api.uploadFiles).not.toHaveBeenCalled();
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
		harness.api.downloadFile.mockResolvedValue({
			path,
			content: Buffer.from(remote).toString('base64'),
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

		const expectedConflictPath = 'notes/conflict (conflict 2026-01-02 03-04).md';

		expect(harness.api.uploadFiles).not.toHaveBeenCalled();
		expect(harness.vault.createFolder).toHaveBeenCalledWith('notes');
		expect(harness.vault.createBinary).toHaveBeenCalledWith(
			expectedConflictPath,
			expect.any(ArrayBuffer),
		);
		expect(result.conflicts).toEqual([expectedConflictPath]);

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
