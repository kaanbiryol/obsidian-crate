import { describe, expect, it, vi } from 'vitest';
import type { CloudflareDeploymentMetadata } from './deployment-types';
import { CloudflareApiError } from './cloudflare-api';
import { provisionCloudflareDeployment } from './provisioner';
import { createFenceQueryHarness } from './deployment-fence-test-harness';

function createMetadata(): CloudflareDeploymentMetadata {
	return {
		deploymentId: '0123456789abcdef',
		accountId: '0123456789abcdef0123456789abcdef',
		accountName: 'Personal',
		workerName: 'crate-0123456789abcdef',
		d1DatabaseName: 'crate-0123456789abcdef',
		d1DatabaseId: '01234567-89ab-cdef-0123-456789abcdef',
		r2BucketName: 'crate-0123456789abcdef',
		workersSubdomain: 'personal-crate',
		lastDeployedVersion: null,
		lastDeployedFingerprint: null,
	};
}

const artifacts = {
	version: '0.1.0',
	fingerprint: 'f'.repeat(64),
	workerBundle: 'export default {};',
	workerBundleSha256: 'worker-hash',
	d1Schema: 'CREATE TABLE IF NOT EXISTS example (id TEXT);',
	d1SchemaSha256: 'schema-hash',
};

function createApi() {
	const fence = createFenceQueryHarness();
	const metadata = createMetadata();
	return {
		getWorkerSettings: vi.fn(async () => ({ annotations: { 'workers/message': 'Crate 0.1.0' }, bindings: [
			{ type: 'd1', name: 'DB', id: metadata.d1DatabaseId! }, { type: 'r2_bucket', name: 'BUCKET', bucket_name: metadata.r2BucketName },
		] })),
		getD1Database: vi.fn(async (_accountId: string, databaseId: string) => ({ uuid: databaseId, name: metadata.d1DatabaseName })),
		findD1Database: vi.fn(async () => ({ uuid: metadata.d1DatabaseId!, name: metadata.d1DatabaseName })),
		createD1Database: vi.fn(),
		getR2Bucket: vi.fn(async () => ({ name: 'crate-0123456789abcdef' })),
		createR2Bucket: vi.fn(),
		queryD1: vi.fn(async (_account: string, _database: string, sql: string, params?: string[]): Promise<Array<{ results?: Array<Record<string, unknown>> }>> => fence.query(sql, params) ?? []),
		uploadWorker: vi.fn(async () => {}),
		updateWorkerSchedules: vi.fn(async () => {}),
		getWorkersSubdomain: vi.fn(async () => 'personal-crate'),
		createWorkersSubdomain: vi.fn(),
		enableWorkerSubdomain: vi.fn(async () => {}),
	};
}

describe('provisionCloudflareDeployment', () => {
	it('rejects a newer remote Worker before changing schema or uploading code', async () => {
		const api = createApi();
		api.getWorkerSettings.mockResolvedValue({ annotations: { 'workers/message': 'Crate 9.0.0' }, bindings: [] });
		const metadata = createMetadata();
		await expect(provisionCloudflareDeployment({ api: api as never, accountId: metadata.accountId!, metadata, artifacts, onMetadataChanged: async () => {} }))
			.rejects.toThrow('downgrades are not supported');
		expect(api.queryD1).not.toHaveBeenCalled();
		expect(api.uploadWorker).not.toHaveBeenCalled();
	});
	it('reuses persisted resources and initializes the idempotent schema before upload', async () => {
		const api = createApi();
		const metadata = createMetadata();
		const onMetadataChanged = vi.fn(async () => {});

		const workerUrl = await provisionCloudflareDeployment({
			api: api as never,
			accountId: metadata.accountId!,
			metadata,
			artifacts,
			onMetadataChanged,
		});

		expect(api.createD1Database).not.toHaveBeenCalled();
		expect(api.createR2Bucket).not.toHaveBeenCalled();
		expect(api.createWorkersSubdomain).not.toHaveBeenCalled();
		expect(api.queryD1).toHaveBeenCalledWith(
			metadata.accountId,
			metadata.d1DatabaseId,
			artifacts.d1Schema,
		);
		expect(api.uploadWorker).toHaveBeenCalledWith(expect.objectContaining({
			workerName: metadata.workerName,
			d1DatabaseId: metadata.d1DatabaseId,
			r2BucketName: metadata.r2BucketName,
		}));
		expect(api.enableWorkerSubdomain).toHaveBeenCalledTimes(1);
		expect(api.updateWorkerSchedules).toHaveBeenCalledWith(
			metadata.accountId,
			metadata.workerName,
			[],
		);
		expect(metadata.lastDeployedVersion).toBe('0.1.0');
		expect(metadata.lastDeployedFingerprint).toBe('f'.repeat(64));
		expect(workerUrl).toBe('https://crate-0123456789abcdef.personal-crate.workers.dev');
	});

	it.each([
		{ tables: ['files'], version: 999 },
		{ tables: ['crate_schema'], version: 999 },
		{ tables: ['crate_schema'], version: 1 },
	])('rejects an unsupported existing database before uploading: %j', async ({ tables, version }) => {
		const api = createApi();
		api.queryD1.mockResolvedValueOnce([{ results: tables.map(name => ({ name })) }]);
		api.queryD1.mockResolvedValueOnce([{ results: [{ version }] }]);
		const metadata = createMetadata();
		await expect(provisionCloudflareDeployment({ api: api as never, accountId: metadata.accountId!, metadata, artifacts, onMetadataChanged: async () => {} }))
			.rejects.toThrow('Unsupported database schema');
		expect(api.uploadWorker).not.toHaveBeenCalled();
		expect(api.queryD1).not.toHaveBeenCalledWith(metadata.accountId, metadata.d1DatabaseId, artifacts.d1Schema);
	});

	it.each([2, 3, 4])('applies the additive schema upgrade or retries initialization from schema %i', async version => {
		const api = createApi();
		api.queryD1.mockResolvedValueOnce([{ results: [{ name: 'crate_schema' }] }]);
		api.queryD1.mockResolvedValueOnce([{ results: [{ version }] }]);
		const metadata = createMetadata();
		await provisionCloudflareDeployment({ api: api as never, accountId: metadata.accountId!, metadata, artifacts, onMetadataChanged: async () => {} });
		expect(api.queryD1).toHaveBeenCalledWith(metadata.accountId, metadata.d1DatabaseId, artifacts.d1Schema);
		expect(api.uploadWorker).toHaveBeenCalledOnce();
	});

	it('explains how to activate R2 when the account is not entitled', async () => {
		const api = createApi();
		api.getR2Bucket.mockRejectedValue(new CloudflareApiError('not entitled', 403, 10042));

		await expect(provisionCloudflareDeployment({
			api: api as never,
			accountId: '0123456789abcdef0123456789abcdef',
			metadata: createMetadata(),
			artifacts,
			onMetadataChanged: vi.fn(async () => {}),
		})).rejects.toThrow('Enable an R2 subscription');
	});
});
