import { describe, expect, it, vi } from 'vitest';
import type { PreparedUpload, SyncResult } from '../types';

const conflictMocks = vi.hoisted(() => ({
	createConflictCopy: vi.fn(async () => 'notes/file (conflict).md'),
}));

vi.mock('./conflict', () => ({
	createConflictCopy: conflictMocks.createConflictCopy,
}));

import {
	createVaultFileChunks,
	parallelDownloadAndSaveFiles,
	prepareUploadFromPath,
	prepareUploadFromVaultFile,
	processDiff,
	saveDownloadedContent,
	uploadPreparedFiles,
} from './transfer';

function createTransferHarness() {
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
	};
	const localManifest = {
		hashMatches: vi.fn(() => false),
		setEntry: vi.fn(),
		removeEntry: vi.fn(),
	};
	const retryWithBackoff = vi.fn(async (fn: () => Promise<unknown>) => fn());
	const retryWithBackoffTyped = <T>(fn: () => Promise<T>): Promise<T> =>
		retryWithBackoff(fn as () => Promise<unknown>) as Promise<T>;
	const getModifiedIso = vi.fn(async () => '2026-02-15T00:00:00.000Z');

	return {
		adapter,
		vault,
		api,
		localManifest,
		retryWithBackoff,
		getModifiedIso,
			context: {
				vault: vault as never,
				api,
				localManifest,
				runConcurrent: async <T>(tasks: Array<() => Promise<T>>) => Promise.all(tasks.map(task => task())),
				retryWithBackoff: retryWithBackoffTyped,
				getModifiedIso,
			},
		};
	}

function emptyResult(): SyncResult {
	return {
		success: true,
		uploaded: 0,
		downloaded: 0,
		deleted: 0,
		conflicts: [],
		errors: [],
	};
}

describe('transfer prepare helpers', () => {
	it('skips upload when manifest hash already matches', async () => {
		const harness = createTransferHarness();
		harness.adapter.readBinary.mockResolvedValue(new TextEncoder().encode('same').buffer as ArrayBuffer);
		harness.localManifest.hashMatches.mockReturnValue(true);

		const result = await prepareUploadFromVaultFile(harness.context, {
			path: 'notes/a.md',
			size: 4,
			mtime: 1,
			extension: 'md',
		});

		expect(result).toBeNull();
		expect(harness.localManifest.hashMatches).toHaveBeenCalled();
	});

	it('prepares hidden path uploads by stat + adapter read', async () => {
		const harness = createTransferHarness();
		harness.vault.getAbstractFileByPath.mockReturnValue(null);
		harness.adapter.stat.mockResolvedValue({ type: 'file', size: 5, mtime: 123 });
		harness.adapter.readBinary.mockResolvedValue(new TextEncoder().encode('{"a":1}').buffer as ArrayBuffer);

		const result = await prepareUploadFromPath(harness.context, '.obsidian/config.json');

		expect(result).toEqual(
			expect.objectContaining({
				path: '.obsidian/config.json',
				contentType: 'application/json',
			}),
		);
	});
});

describe('transfer download/process helpers', () => {
	it('saves downloaded content and records manifest entry', async () => {
		const harness = createTransferHarness();
		harness.vault.getAbstractFileByPath.mockReturnValue(null);
		const content = new TextEncoder().encode('hello').buffer as ArrayBuffer;

		await saveDownloadedContent(harness.context, 'notes/a.md', content);

		expect(harness.vault.createFolder).toHaveBeenCalledWith('notes');
		expect(harness.vault.createBinary).toHaveBeenCalledWith('notes/a.md', content);
		expect(harness.localManifest.setEntry).toHaveBeenCalledWith(
			'notes/a.md',
			expect.objectContaining({ size: 5, modified: '2026-02-15T00:00:00.000Z' }),
		);
	});

	it('processes conflict diffs by writing conflict copy and remote replacement', async () => {
		const harness = createTransferHarness();
		const local = new TextEncoder().encode('local').buffer as ArrayBuffer;
		const remote = new TextEncoder().encode('remote').buffer as ArrayBuffer;
		harness.vault.getAbstractFileByPath.mockReturnValue({ path: 'notes/a.md', extension: 'md' });
		harness.adapter.readBinary.mockResolvedValue(local);
		harness.api.downloadFile.mockResolvedValue({
			content: remote,
			contentType: 'text/markdown',
			size: remote.byteLength,
		});

		const result = emptyResult();
		const localFiles: Record<string, { hash: string; size: number; modified: string }> = {};

		await processDiff(
			harness.context,
			{ path: 'notes/a.md', action: 'conflict', localHash: 'l', remoteHash: 'r' },
			localFiles,
			result,
		);

		expect(conflictMocks.createConflictCopy).toHaveBeenCalled();
		expect(harness.vault.modifyBinary).toHaveBeenCalledWith({ path: 'notes/a.md', extension: 'md' }, remote);
		expect(result.conflicts).toEqual(['notes/file (conflict).md']);
		expect(localFiles['notes/a.md']?.size).toBe(remote.byteLength);
		expect(harness.localManifest.setEntry).toHaveBeenCalledWith(
			'notes/a.md',
			expect.objectContaining({ size: remote.byteLength }),
		);
	});

	it('aggregates per-path download errors during parallel downloads', async () => {
		const harness = createTransferHarness();
		harness.vault.getAbstractFileByPath.mockReturnValue(null);
		harness.api.downloadFile.mockImplementation(async (path: string) => {
			if (path === 'bad.md') {
				throw new Error('network down');
			}
			return {
				content: new TextEncoder().encode('ok').buffer as ArrayBuffer,
				contentType: 'text/plain',
				size: 2,
			};
		});

		const result = emptyResult();
		await parallelDownloadAndSaveFiles(harness.context, ['good.md', 'bad.md'], result, 5);

		expect(result.downloaded).toBe(1);
		expect(result.errors).toContain('bad.md: network down');
	});
});

describe('transfer upload helpers', () => {
	it('uses retry wrapper and records hash mismatch errors', async () => {
		const harness = createTransferHarness();
		harness.api.uploadFile.mockResolvedValue({
			success: true,
			path: 'notes/a.md',
			hash: 'different-hash',
		});

		const prepared: PreparedUpload[] = [
			{
				path: 'notes/a.md',
				content: new TextEncoder().encode('x').buffer as ArrayBuffer,
				hash: 'expected-hash',
				size: 1,
				contentType: 'text/plain',
			},
		];
		const result = emptyResult();

		await uploadPreparedFiles(harness.context, prepared, result, { concurrency: 2, retry: true });

		expect(harness.retryWithBackoff).toHaveBeenCalledTimes(1);
		expect(result.uploaded).toBe(0);
		expect(result.errors).toContain(
			'notes/a.md: Hash mismatch after upload (expected expected-hash, got different-hash)',
		);
	});

	it('chunks files for initial sync pipelining', () => {
		const files = [
			{ path: 'a.md', size: 1, mtime: 1, extension: 'md' },
			{ path: 'b.md', size: 1, mtime: 1, extension: 'md' },
			{ path: 'c.md', size: 1, mtime: 1, extension: 'md' },
		];

		const chunks = createVaultFileChunks(files, 2);

		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toHaveLength(2);
		expect(chunks[1]).toHaveLength(1);
	});
});
