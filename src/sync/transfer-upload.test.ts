import { describe, expect, it, vi } from 'vitest';
import type { PreparedUpload } from './types';
import { HttpError } from './api';
import { uploadPreparedFiles } from './transfer';
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

		// Create three batches of five small files.
		const prepared: PreparedUpload[] = Array.from({ length: 15 }, (_, i) => ({
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

		expect(harness.api.batchUpload).toHaveBeenCalledTimes(3); // 15 files / 5 per batch = 3 batches
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

	it('reconciles structured version conflicts returned by a batch upload', async () => {
		const harness = createTransferHarness();
		harness.api.batchUpload.mockResolvedValue({
			success: false,
			results: [{
				path: 'notes/a.md',
				success: false,
				error: 'Remote file changed since it was read',
				code: 'version_conflict',
				status: 409,
				currentHash: 'remote-hash',
			}],
		});
		const result = emptyResult();
		const onVersionConflicts = vi.fn(async (paths: string[], syncResult: typeof result) => {
			syncResult.downloaded++;
			syncResult.downloadedPaths.push(paths[0]!);
		});

		await uploadPreparedFiles(harness.context, [{
			path: 'notes/a.md',
			content: new TextEncoder().encode('local').buffer as ArrayBuffer,
			hash: 'local-hash',
			size: 5,
			expectedHash: 'base-hash',
		}], result, { concurrency: 2, retry: false, onVersionConflicts });

		expect(onVersionConflicts).toHaveBeenCalledWith(['notes/a.md'], result);
		expect(result.errors).toEqual([]);
		expect(result.downloadedPaths).toEqual(['notes/a.md']);
	});

	it('reconciles a 409 from an individual large-file upload', async () => {
		const harness = createTransferHarness();
		harness.api.uploadFile.mockRejectedValue(new HttpError(
			'Remote file changed since it was read',
			409,
			null,
			'version_conflict',
			'remote-hash',
		));
		const result = emptyResult();
		const onVersionConflicts = vi.fn(async () => {});

		await uploadPreparedFiles(harness.context, [{
			path: 'large.bin',
			content: new ArrayBuffer(1024 * 1024),
			hash: 'local-hash',
			size: 1024 * 1024,
			expectedHash: 'base-hash',
		}], result, { concurrency: 2, retry: false, onVersionConflicts });

		expect(onVersionConflicts).toHaveBeenCalledWith(['large.bin'], result);
		expect(result.errors).toEqual([]);
	});

});
