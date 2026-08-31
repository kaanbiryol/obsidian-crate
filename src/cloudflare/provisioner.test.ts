import { describe, expect, it, vi } from 'vitest';
import type { CloudflareDeploymentMetadata } from '../plugin/types';
import { CloudflareApiError } from './cloudflare-api';
import { provisionCloudflareDeployment } from './provisioner';

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
	d1Migrations: [],
};

function createApi() {
	return {
		getD1Database: vi.fn(async (_accountId: string, databaseId: string) => ({ uuid: databaseId })),
		findD1Database: vi.fn(),
		createD1Database: vi.fn(),
		getR2Bucket: vi.fn(async () => ({ name: 'crate-0123456789abcdef' })),
		createR2Bucket: vi.fn(),
		queryD1: vi.fn(async (): Promise<Array<{ results?: Array<Record<string, unknown>> }>> => []),
		uploadWorker: vi.fn(async () => {}),
		updateWorkerSchedules: vi.fn(async () => {}),
		getWorkersSubdomain: vi.fn(async () => 'personal-crate'),
		createWorkersSubdomain: vi.fn(),
		enableWorkerSubdomain: vi.fn(async () => {}),
	};
}

describe('provisionCloudflareDeployment', () => {
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
		expect(api.queryD1).toHaveBeenCalledTimes(2);
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
			['*/15 * * * *'],
		);
		expect(metadata.lastDeployedVersion).toBe('0.1.0');
		expect(metadata.lastDeployedFingerprint).toBe('f'.repeat(64));
		expect(workerUrl).toBe('https://crate-0123456789abcdef.personal-crate.workers.dev');
	});

	it('applies only pending D1 migrations before uploading the Worker', async () => {
		const api = createApi();
		api.queryD1
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ results: [{ name: '0001_initial.sql' }] }])
			.mockResolvedValueOnce([]);
		const metadata = createMetadata();
		const migrations = [
			{ name: '0002_add_example.sql', sql: 'ALTER TABLE example ADD COLUMN title TEXT;', sha256: 'hash' },
		];

		await provisionCloudflareDeployment({
			api: api as never,
			accountId: metadata.accountId!,
			metadata,
			artifacts: { ...artifacts, d1Migrations: migrations },
			onMetadataChanged: vi.fn(async () => {}),
		});

		expect(api.queryD1).toHaveBeenNthCalledWith(
			3,
			metadata.accountId,
			metadata.d1DatabaseId,
			"ALTER TABLE example ADD COLUMN title TEXT;\nINSERT INTO d1_migrations (name) VALUES ('0002_add_example.sql');",
		);
		expect(api.uploadWorker).toHaveBeenCalledOnce();
		expect(api.queryD1).toHaveBeenCalledTimes(3);
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
