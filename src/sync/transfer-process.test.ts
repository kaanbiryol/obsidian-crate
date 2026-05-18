import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeHash } from './hasher';
import { processDiff } from './transfer-process';
import { createEmptySyncResult } from './sync-result';
import type { FileEntry } from '../plugin/types';
import type { TransferContext } from './transfer-types';

function toArrayBuffer(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function fromArrayBuffer(buffer: ArrayBuffer): string {
	return new TextDecoder().decode(new Uint8Array(buffer));
}

function createProcessHarness() {
	const adapter = {
		readBinary: vi.fn(),
		stat: vi.fn(),
		exists: vi.fn(),
		mkdir: vi.fn(),
		writeBinary: vi.fn(),
	};
	const vault = {
		adapter,
		getAbstractFileByPath: vi.fn(),
		createFolder: vi.fn(),
		modifyBinary: vi.fn(),
		createBinary: vi.fn(),
	};
	const api = {
		uploadFile: vi.fn(),
		downloadFile: vi.fn(),
		deleteFile: vi.fn(),
		batchUpload: vi.fn(),
		batchDownload: vi.fn(),
	};
	const localManifest = {
		getEntry: vi.fn(),
		hashMatches: vi.fn(() => false),
		setEntry: vi.fn(),
		removeEntry: vi.fn(),
	};
	const markdownBaseCache = {
		readBase: vi.fn(),
		putBase: vi.fn(),
	};
	const context: TransferContext = {
		vault: vault as never,
		api,
		localManifest,
		markdownBaseCache,
		runConcurrent: async <T>(tasks: Array<() => Promise<T>>) => Promise.all(tasks.map(task => task())),
		retryWithBackoff: async <T>(fn: () => Promise<T>) => fn(),
		getModifiedIso: vi.fn(async () => '2026-02-15T00:00:00.000Z'),
	};

	return {
		adapter,
		vault,
		api,
		localManifest,
		markdownBaseCache,
		context,
	};
}

describe('processDiff conflict handling', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('creates a conflict copy and replaces the main file with remote content', async () => {
		const harness = createProcessHarness();
		const path = 'notes/merge.md';
		const local = 'LOCAL\nline2\nline3';
		const remote = 'line1\nline2\nREMOTE';
		const localFile = { path, extension: 'md' };
		harness.vault.getAbstractFileByPath.mockReturnValue(localFile);
		harness.adapter.readBinary.mockResolvedValue(toArrayBuffer(local));
		harness.api.downloadFile.mockResolvedValue({
			content: toArrayBuffer(remote),
			contentType: 'text/markdown',
			size: remote.length,
		});

		const localFiles: Record<string, FileEntry> = {};
		const result = createEmptySyncResult();

		await processDiff(
			harness.context,
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

		const conflictContent = harness.vault.createBinary.mock.calls[0]?.[1] as ArrayBuffer;
		expect(fromArrayBuffer(conflictContent)).toBe(local);

		const mergedWritten = harness.vault.modifyBinary.mock.calls[0]?.[1] as ArrayBuffer;
		expect(fromArrayBuffer(mergedWritten)).toBe(remote);
		expect(localFiles[path]).toEqual(
			expect.objectContaining({
				hash: await computeHash(mergedWritten),
				size: mergedWritten.byteLength,
			}),
		);
		expect(harness.localManifest.setEntry).toHaveBeenCalledWith(
			path,
			expect.objectContaining({ size: mergedWritten.byteLength }),
		);
	});

	it('auto-merges non-overlapping markdown conflicts and uploads the merged content', async () => {
		const harness = createProcessHarness();
		const path = 'notes/merge.md';
		const base = 'title\nbase local\nbase remote\n';
		const local = 'title\nlocal edit\nbase remote\n';
		const remote = 'title\nbase local\nremote edit\n';
		const localFile = { path, extension: 'md' };
		const baseHash = await computeHash(toArrayBuffer(base));
		harness.localManifest.getEntry.mockReturnValue({
			hash: baseHash,
			size: base.length,
			modified: '2026-02-14T00:00:00.000Z',
		});
		harness.markdownBaseCache.readBase.mockResolvedValue(toArrayBuffer(base));
		harness.vault.getAbstractFileByPath.mockReturnValue(localFile);
		harness.adapter.readBinary.mockResolvedValue(toArrayBuffer(local));
		harness.api.downloadFile.mockResolvedValue({
			content: toArrayBuffer(remote),
			contentType: 'text/markdown',
			size: remote.length,
		});
		harness.api.uploadFile.mockImplementation(async (
			_uploadPath: string,
			_content: ArrayBuffer,
			hash: string,
		) => ({ success: true, path, hash }));

		const localFiles: Record<string, FileEntry> = {};
		const result = createEmptySyncResult();

		await processDiff(
			harness.context,
			{ path, action: 'conflict', localHash: 'l', remoteHash: 'r' },
			localFiles,
			result,
		);

		expect(result.conflicts).toEqual([]);
		expect(result.merged).toBe(1);
		expect(result.mergedPaths).toEqual([path]);
		expect(harness.vault.createBinary).not.toHaveBeenCalled();
		expect(harness.api.uploadFile).toHaveBeenCalledTimes(1);
		expect(harness.vault.modifyBinary).toHaveBeenCalledTimes(1);

		const mergedWritten = harness.vault.modifyBinary.mock.calls[0]?.[1] as ArrayBuffer;
		expect(fromArrayBuffer(mergedWritten)).toBe('title\nlocal edit\nremote edit\n');
		expect(localFiles[path]).toEqual(
			expect.objectContaining({
				hash: await computeHash(mergedWritten),
				size: mergedWritten.byteLength,
			}),
		);
		expect(harness.markdownBaseCache.putBase).toHaveBeenCalledWith(
			path,
			await computeHash(mergedWritten),
			mergedWritten,
		);
	});

	it('uses deterministic timestamp format for visible conflict copies', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));

		const harness = createProcessHarness();
		const path = 'notes/conflict.md';
		const local = 'line1\nLOCAL\nline3';
		const remote = 'line1\nREMOTE\nline3';
		const localFile = { path, extension: 'md' };
		harness.vault.getAbstractFileByPath.mockReturnValue(localFile);
		harness.adapter.readBinary.mockResolvedValue(toArrayBuffer(local));
		harness.api.downloadFile.mockResolvedValue({
			content: toArrayBuffer(remote),
			contentType: 'text/markdown',
			size: remote.length,
		});

		const localFiles: Record<string, FileEntry> = {};
		const result = createEmptySyncResult();

		await processDiff(
			harness.context,
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
