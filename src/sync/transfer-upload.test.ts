import { describe, expect, it } from 'vitest';
import type { PreparedUpload } from '../plugin/types';
import { createVaultFileChunks, uploadPreparedFiles } from './transfer';
import { createTransferHarness, emptyResult } from './transfer-test-harness';

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
		const prepared: PreparedUpload[] = Array.from({ length: 18 }, (_, i) => ({
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

		expect(harness.api.batchUpload).toHaveBeenCalledTimes(3); // 18 files / 6 per batch = 3 batches
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
