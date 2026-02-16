import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as obsidian from 'obsidian';

const apiMocks = vi.hoisted(() => ({
	verifyCredentials: vi.fn(async () => true),
	listR2Buckets: vi.fn(),
	createR2Bucket: vi.fn(),
	createD1Database: vi.fn(),
	listD1Databases: vi.fn(),
	deleteD1Database: vi.fn(),
	listWorkers: vi.fn(),
	deleteWorker: vi.fn(),
	deployWorker: vi.fn(),
	redeployWorker: vi.fn(),
	generateAuthToken: vi.fn(() => 'purge-token'),
	generateBucketName: vi.fn(() => 'crate-bucket-test'),
	generateWorkerName: vi.fn(() => 'crate-sync-test'),
	getWorkerBindings: vi.fn(),
	deleteR2Bucket: vi.fn(),
}));

vi.mock('./api', () => apiMocks);

import { discoverCrateResources, resetInfrastructure } from './infrastructure';

describe('cloudflare infrastructure reset helpers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('discovers bucket/database from worker bindings for non crate-prefixed names', async () => {
		apiMocks.listR2Buckets.mockResolvedValue([
			{ name: 'custom-bucket', creation_date: '2026-02-16T00:00:00.000Z' },
		]);
		apiMocks.listWorkers.mockResolvedValue([
			{ id: 'custom-worker' },
		]);
		apiMocks.listD1Databases.mockResolvedValue([
			{ uuid: 'db-custom-1', name: 'custom-db' },
		]);
		apiMocks.getWorkerBindings.mockResolvedValue([
			{ type: 'r2_bucket', name: 'BUCKET', bucket_name: 'custom-bucket' },
			{ type: 'd1', name: 'DB', id: 'db-custom-1' },
		]);

		const resources = await discoverCrateResources({
			accountId: 'acct',
			apiToken: 'token',
			includeCratePrefixed: false,
			workerName: 'custom-worker',
		});

		expect(resources.workers.map((worker) => worker.id)).toEqual(['custom-worker']);
		expect(resources.buckets.map((bucket) => bucket.name)).toEqual(['custom-bucket']);
		expect(resources.databases.map((database) => database.uuid)).toEqual(['db-custom-1']);
		expect(apiMocks.getWorkerBindings).toHaveBeenCalledWith(
			{ accountId: 'acct', apiToken: 'token' },
			'custom-worker'
		);
	});

	it('retries purge worker requests before deleting a non-empty bucket', async () => {
		apiMocks.listR2Buckets.mockResolvedValue([
			{ name: 'custom-bucket', creation_date: '2026-02-16T00:00:00.000Z' },
		]);
		apiMocks.listWorkers.mockResolvedValue([
			{ id: 'custom-worker' },
		]);
		apiMocks.listD1Databases.mockResolvedValue([
			{ uuid: 'db-custom-1', name: 'custom-db' },
		]);
		apiMocks.getWorkerBindings.mockResolvedValue([
			{ type: 'r2_bucket', name: 'BUCKET', bucket_name: 'custom-bucket' },
			{ type: 'd1', name: 'DB', id: 'db-custom-1' },
		]);
		let deleteBucketCalls = 0;
		apiMocks.deleteR2Bucket.mockImplementation(async () => {
			deleteBucketCalls += 1;
			if (deleteBucketCalls === 1) {
				throw new Error('Bucket not empty');
			}
		});
		apiMocks.deployWorker.mockResolvedValue({
			id: 'temp-worker',
			url: 'https://crate-purge.test.workers.dev',
		});
		apiMocks.deleteWorker.mockResolvedValue(undefined);
		apiMocks.deleteD1Database.mockResolvedValue(undefined);

		const requestUrlSpy = vi.spyOn(obsidian, 'requestUrl')
			.mockRejectedValueOnce(new Error('worker cold start'))
			.mockRejectedValueOnce(new Error('worker routing pending'))
			.mockResolvedValue({
				status: 200,
				json: { deleted: 3 },
			} as never);

		vi.useFakeTimers();
		const resultPromise = resetInfrastructure({
			accountId: 'acct',
			apiToken: 'token',
			workerName: 'custom-worker',
			includeCratePrefixed: false,
		});
		await vi.runAllTimersAsync();
		const result = await resultPromise;

		expect(result.failed).toEqual([]);
		expect(result.deleted).toEqual([
			'Worker custom-worker',
			'D1 database custom-db',
			'R2 bucket custom-bucket',
		]);
		expect(apiMocks.deleteR2Bucket).toHaveBeenCalledTimes(2);
		expect(requestUrlSpy).toHaveBeenCalledTimes(3);
		expect(
			apiMocks.deleteWorker.mock.calls.some((call) => call[1] === 'custom-worker')
		).toBe(true);
		// Purge worker is cleaned up in the second-chance pass after bucket deletion
		expect(
			apiMocks.deleteWorker.mock.calls.some((call) => String(call[1]).startsWith('crate-purge-'))
		).toBe(true);
	});

	it('cleans up purge workers even when bucket retry delete fails', async () => {
		apiMocks.listR2Buckets.mockResolvedValue([
			{ name: 'custom-bucket', creation_date: '2026-02-16T00:00:00.000Z' },
		]);
		apiMocks.listWorkers.mockResolvedValue([
			{ id: 'custom-worker' },
		]);
		apiMocks.listD1Databases.mockResolvedValue([]);
		apiMocks.getWorkerBindings.mockResolvedValue([
			{ type: 'r2_bucket', name: 'BUCKET', bucket_name: 'custom-bucket' },
		]);
		apiMocks.deleteR2Bucket.mockRejectedValue(new Error('Bucket not empty'));
		apiMocks.deployWorker.mockResolvedValue({
			id: 'temp-worker',
			url: 'https://crate-purge.test.workers.dev',
		});
		apiMocks.deleteWorker.mockResolvedValue(undefined);

		vi.spyOn(obsidian, 'requestUrl')
			.mockResolvedValue({
				status: 200,
				json: { deleted: 5 },
			} as never);

		vi.useFakeTimers();
		const resultPromise = resetInfrastructure({
			accountId: 'acct',
			apiToken: 'token',
			workerName: 'custom-worker',
			includeCratePrefixed: false,
		});
		await vi.runAllTimersAsync();
		const result = await resultPromise;

		expect(result.deleted).toEqual(['Worker custom-worker']);
		expect(result.failed.length).toBe(1);
		expect(result.failed[0]).toContain('R2 bucket custom-bucket');
		// Purge worker should still be cleaned up in second-chance pass
		expect(
			apiMocks.deleteWorker.mock.calls.some((call) => String(call[1]).startsWith('crate-purge-'))
		).toBe(true);
	});
});
