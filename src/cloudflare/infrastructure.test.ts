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
	queryD1: vi.fn(),
	generateAuthToken: vi.fn(() => 'purge-token'),
	generateBucketName: vi.fn(() => 'crate-bucket-test'),
	generateWorkerName: vi.fn((prefix = 'crate-sync') => `${prefix}-test`),
	getWorkerBindings: vi.fn(),
	getWorkerSubdomain: vi.fn(),
	deleteR2Bucket: vi.fn(),
}));

vi.mock('./api', () => apiMocks);

import {
	discoverCrateResources,
	quickSetup,
	resetInfrastructure,
	runDiagnostics,
} from './infrastructure';

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

describe('cloudflare infrastructure setup and diagnostics', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('reconnects to existing crate infrastructure before provisioning new resources', async () => {
		apiMocks.listWorkers.mockResolvedValue([{ id: 'crate-sync-existing' }]);
		apiMocks.getWorkerBindings.mockResolvedValue([
			{ type: 'plain_text', name: 'CF_BUCKET_NAME', text: 'crate-bucket-existing' },
			{ type: 'plain_text', name: 'CF_DATABASE_ID', text: 'db-existing' },
		]);
		apiMocks.listR2Buckets.mockResolvedValue([
			{ name: 'crate-bucket-existing', creation_date: '2026-02-16T00:00:00.000Z' },
		]);
		apiMocks.listD1Databases.mockResolvedValue([
			{ uuid: 'db-existing', name: 'crate-sync-existing' },
		]);
		apiMocks.getWorkerSubdomain.mockResolvedValue('workers-subdomain');

		const result = await quickSetup({
			accountId: 'acct',
			apiToken: 'token',
		});

		expect(result).toEqual({
			workerUrl: 'https://crate-sync-existing.workers-subdomain.workers.dev',
			authToken: 'purge-token',
			bucketName: 'crate-bucket-existing',
			workerName: 'crate-sync-existing',
			databaseId: 'db-existing',
			bucketCreated: false,
		});
		expect(apiMocks.queryD1).toHaveBeenCalledWith(
			{ accountId: 'acct', apiToken: 'token' },
			'db-existing',
			'INSERT INTO auth_tokens (id, token_hash, device_name) VALUES (?, ?, ?)',
			expect.arrayContaining([expect.any(String), expect.any(String), 'plugin-reconnect']),
		);
		expect(apiMocks.redeployWorker).toHaveBeenCalledWith(
			{ accountId: 'acct', apiToken: 'token' },
			'crate-sync-existing',
			expect.any(String),
		);
		expect(apiMocks.createR2Bucket).not.toHaveBeenCalled();
		expect(apiMocks.createD1Database).not.toHaveBeenCalled();
		expect(apiMocks.deployWorker).not.toHaveBeenCalled();
	});

	it('provisions new infrastructure and registers the generated worker token', async () => {
		apiMocks.listWorkers.mockResolvedValue([]);
		apiMocks.listR2Buckets.mockResolvedValue([]);
		apiMocks.createD1Database.mockResolvedValue({ uuid: 'db-created' });
		apiMocks.deployWorker.mockResolvedValue({
			id: 'crate-sync-test',
			url: 'https://crate-sync-test.example.workers.dev',
		});

		const requestUrlSpy = vi.spyOn(obsidian, 'requestUrl').mockResolvedValue({
			status: 200,
			json: {},
		} as never);

		const result = await quickSetup({
			accountId: 'acct',
			apiToken: 'token',
		});

		expect(result).toEqual({
			workerUrl: 'https://crate-sync-test.example.workers.dev',
			authToken: 'purge-token',
			bucketName: 'crate-bucket-test',
			workerName: 'crate-sync-test',
			databaseId: 'db-created',
			bucketCreated: true,
		});
		expect(apiMocks.createR2Bucket).toHaveBeenCalledWith(
			{ accountId: 'acct', apiToken: 'token' },
			'crate-bucket-test',
		);
		expect(apiMocks.createD1Database).toHaveBeenCalledWith(
			{ accountId: 'acct', apiToken: 'token' },
			'crate-crate-sync-test',
		);
		expect(apiMocks.deployWorker).toHaveBeenCalledWith(
			{ accountId: 'acct', apiToken: 'token' },
			'crate-sync-test',
			expect.any(String),
			expect.objectContaining({
				r2Bucket: 'crate-bucket-test',
				d1DatabaseId: 'db-created',
				authToken: 'purge-token',
			}),
		);
		expect(requestUrlSpy).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				url: 'https://crate-sync-test.example.workers.dev/health',
				method: 'GET',
			}),
		);
		expect(requestUrlSpy).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				url: 'https://crate-sync-test.example.workers.dev/auth/tokens',
				method: 'POST',
			}),
		);
	});

	it('reports worker auth failures and missing configured resources in diagnostics', async () => {
		apiMocks.verifyCredentials.mockResolvedValue(true);
		apiMocks.listR2Buckets.mockResolvedValue([]);
		apiMocks.listWorkers.mockResolvedValue([]);
		apiMocks.listD1Databases.mockResolvedValue([]);

		const requestUrlSpy = vi.spyOn(obsidian, 'requestUrl').mockResolvedValue({
			status: 401,
			json: {},
		} as never);

		const results = await runDiagnostics({
			workerUrl: 'https://crate-sync-test.example.workers.dev',
			authToken: 'token',
			accountId: 'acct',
			apiToken: 'cloudflare-token',
			workerName: 'crate-sync-test',
			bucketName: 'crate-bucket-test',
			databaseId: 'db-created',
		});

		expect(results).toEqual([
			{
				name: 'Worker health',
				status: 'fail',
				message: 'Authentication failed. Check the worker auth token.',
			},
			{
				name: 'Cloudflare credentials',
				status: 'pass',
				message: 'Credentials verified.',
			},
			{
				name: 'R2 access',
				status: 'pass',
				message: 'Accessible. 0 bucket(s) found.',
			},
			{
				name: 'Workers access',
				status: 'pass',
				message: 'Accessible. 0 worker(s) found.',
			},
			{
				name: 'D1 access',
				status: 'pass',
				message: 'Accessible. 0 database(s) found.',
			},
			{
				name: 'Configured worker',
				status: 'warn',
				message: 'Worker crate-sync-test was not found.',
			},
			{
				name: 'Configured bucket',
				status: 'warn',
				message: 'Bucket crate-bucket-test was not found.',
			},
			{
				name: 'Configured database',
				status: 'warn',
				message: 'Database db-created was not found.',
			},
		]);
		expect(requestUrlSpy).toHaveBeenCalledTimes(1);
	});
});
