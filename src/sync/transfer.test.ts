import { describe, expect, it, vi } from 'vitest';
import type { PreparedUpload, SyncResult } from '../plugin/types';

const conflictMocks = vi.hoisted(() => ({
	createConflictCopy: vi.fn(async () => 'notes/file (conflict).md'),
}));

vi.mock('./conflict', () => ({
	createConflictCopy: conflictMocks.createConflictCopy,
}));

import {
	createBatchUploadChunks,
	createVaultFileChunks,
	parallelDownloadAndSaveFiles,
	prepareUploadFromPath,
	prepareUploadFromVaultFile,
	processDiff,
	saveDownloadedContent,
	uploadPreparedFiles,
} from './transfer';

const CONFIG_DIR = '.vault-config';
const HIDDEN_CONFIG_PATH = `${CONFIG_DIR}/config.json`;

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
		batchUpload: vi.fn(),
		batchDownload: vi.fn(),
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
		uploadedPaths: [],
		downloadedPaths: [],
		deletedPaths: [],
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

		const result = await prepareUploadFromPath(harness.context, HIDDEN_CONFIG_PATH);

		expect(result).toEqual(
			expect.objectContaining({
				path: HIDDEN_CONFIG_PATH,
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

	it('uploads planned full-sync diffs even when the local manifest hash already matches', async () => {
		const harness = createTransferHarness();
		const content = new TextEncoder().encode('local').buffer as ArrayBuffer;
		harness.vault.getAbstractFileByPath.mockReturnValue({
			path: 'notes/a.md',
			extension: 'md',
			stat: { size: 5, mtime: 1700000000000 },
		});
		harness.adapter.readBinary.mockResolvedValue(content);
		harness.localManifest.hashMatches.mockReturnValue(true);
		harness.api.uploadFile.mockResolvedValue({
			success: true,
			path: 'notes/a.md',
			hash: 'expected-hash',
		});

		const result = emptyResult();
		const localFiles: Record<string, { hash: string; size: number; modified: string }> = {};

		await processDiff(
			harness.context,
			{ path: 'notes/a.md', action: 'upload', localHash: 'l' },
			localFiles,
			result,
		);

		expect(harness.api.uploadFile).toHaveBeenCalledWith(
			'notes/a.md',
			content,
			expect.any(String),
			5,
			'text/markdown',
		);
		expect(result.uploaded).toBe(1);
		expect(result.uploadedPaths).toEqual(['notes/a.md']);
	});

	it('aggregates per-path download errors during batch downloads', async () => {
		const harness = createTransferHarness();
		harness.vault.getAbstractFileByPath.mockReturnValue(null);

		const okContent = new TextEncoder().encode('ok');
		const b64 = btoa(String.fromCharCode(...okContent));

		harness.api.batchDownload.mockResolvedValue({
			files: [
				{ path: 'good.md', content: b64, hash: 'h1', size: 2, contentType: 'text/plain' },
				{ path: 'bad.md', content: '', hash: '', size: 0, contentType: '', error: 'File not found' },
			],
		});

		const result = emptyResult();
		await parallelDownloadAndSaveFiles(harness.context, ['good.md', 'bad.md'], result, 5);

		expect(result.downloaded).toBe(1);
		expect(result.errors).toContain('bad.md: File not found');
	});

	it('falls back to individual downloads when batch fails', async () => {
		const harness = createTransferHarness();
		harness.vault.getAbstractFileByPath.mockReturnValue(null);
		harness.api.batchDownload.mockRejectedValue(new Error('batch endpoint not available'));
		harness.api.downloadFile.mockResolvedValue({
			content: new TextEncoder().encode('ok').buffer as ArrayBuffer,
			contentType: 'text/plain',
			size: 2,
		});

		const result = emptyResult();
		await parallelDownloadAndSaveFiles(harness.context, ['fallback.md'], result, 5);

		expect(harness.api.downloadFile).toHaveBeenCalledWith('fallback.md');
		expect(result.downloaded).toBe(1);
	});
});

describe('transfer upload helpers', () => {
	it('uses retry wrapper and records hash mismatch errors via batch upload', async () => {
		const harness = createTransferHarness();
		harness.api.batchUpload.mockResolvedValue({
			success: true,
			results: [{ path: 'notes/a.md', success: true, hash: 'different-hash' }],
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

	it('runs batch uploads concurrently when batchConcurrency > 1', async () => {
		const harness = createTransferHarness();
		let concurrentCalls = 0;
		let maxConcurrentCalls = 0;

		harness.api.batchUpload.mockImplementation(async () => {
			concurrentCalls++;
			maxConcurrentCalls = Math.max(maxConcurrentCalls, concurrentCalls);
			await new Promise(resolve => setTimeout(resolve, 10));
			const results = [{ path: 'file.md', success: true, hash: 'h' }];
			concurrentCalls--;
			return { success: true, results };
		});

		// Create 3 batches of small files (3 files, each in its own batch of 1 via count limit)
		const prepared: PreparedUpload[] = Array.from({ length: 150 }, (_, i) => ({
			path: `file-${i}.md`,
			content: new TextEncoder().encode('x').buffer as ArrayBuffer,
			hash: `hash-${i}`,
			size: 1,
			contentType: 'text/plain',
		}));
		const result = emptyResult();

		await uploadPreparedFiles(harness.context, prepared, result, {
			concurrency: 2,
			retry: false,
			batchConcurrency: 3,
		});

		expect(harness.api.batchUpload).toHaveBeenCalledTimes(3); // 150 files / 50 per batch = 3 batches
		expect(maxConcurrentCalls).toBeGreaterThan(1);
	});

	it('falls back to individual upload for large files', async () => {
		const harness = createTransferHarness();
		const largeContent = new ArrayBuffer(1024 * 1024); // exactly 1MB
		harness.api.uploadFile.mockResolvedValue({
			success: true,
			path: 'large.bin',
			hash: 'large-hash',
		});

		const prepared: PreparedUpload[] = [
			{
				path: 'large.bin',
				content: largeContent,
				hash: 'large-hash',
				size: 1024 * 1024,
				contentType: 'application/octet-stream',
			},
		];
		const result = emptyResult();

		await uploadPreparedFiles(harness.context, prepared, result, { concurrency: 2, retry: false });

		expect(harness.api.batchUpload).not.toHaveBeenCalled();
		expect(harness.api.uploadFile).toHaveBeenCalledTimes(1);
		expect(result.uploaded).toBe(1);
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

describe('batch upload chunking', () => {
	it('respects file count limit', () => {
		const prepared: PreparedUpload[] = Array.from({ length: 120 }, (_, i) => ({
			path: `file-${i}.md`,
			content: new ArrayBuffer(100),
			hash: `hash-${i}`,
			size: 100,
			contentType: 'text/plain',
		}));

		const chunks = createBatchUploadChunks(prepared);

		expect(chunks).toHaveLength(3);
		expect(chunks[0]).toHaveLength(50);
		expect(chunks[1]).toHaveLength(50);
		expect(chunks[2]).toHaveLength(20);
	});

	it('respects byte size limit', () => {
		const prepared: PreparedUpload[] = [
			{ path: 'a.md', content: new ArrayBuffer(6_000_000), hash: 'a', size: 6_000_000, contentType: 'text/plain' },
			{ path: 'b.md', content: new ArrayBuffer(6_000_000), hash: 'b', size: 6_000_000, contentType: 'text/plain' },
			{ path: 'c.md', content: new ArrayBuffer(100), hash: 'c', size: 100, contentType: 'text/plain' },
		];

		const chunks = createBatchUploadChunks(prepared);

		// a.md = 6MB (first chunk), b.md = 6MB won't fit with a.md (new chunk), c.md fits with b.md
		expect(chunks).toHaveLength(2);
		expect(chunks[0]).toHaveLength(1);
		expect(chunks[0]?.[0]?.path).toBe('a.md');
		expect(chunks[1]).toHaveLength(2);
		expect(chunks[1]?.[0]?.path).toBe('b.md');
		expect(chunks[1]?.[1]?.path).toBe('c.md');
	});

	it('returns empty array for empty input', () => {
		expect(createBatchUploadChunks([])).toEqual([]);
	});
});
