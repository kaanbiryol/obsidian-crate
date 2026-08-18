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
	};
}

const artifacts = {
	version: '0.1.0',
	workerBundle: 'export default {};',
	workerBundleSha256: 'worker-hash',
	d1Migrations: [{ name: '0001.sql', sql: 'CREATE TABLE example (id TEXT);', sha256: 'migration-hash' }],
};

function createApi() {
	let queryCount = 0;
	return {
		getD1Database: vi.fn(async (_accountId: string, databaseId: string) => ({ uuid: databaseId })),
		findD1Database: vi.fn(),
		createD1Database: vi.fn(),
		getR2Bucket: vi.fn(async () => ({ name: 'crate-0123456789abcdef' })),
		createR2Bucket: vi.fn(),
		queryD1: vi.fn(async () => {
			queryCount += 1;
			return queryCount === 2 ? [{ results: [] }] : [];
		}),
		uploadWorker: vi.fn(async () => {}),
		getWorkersSubdomain: vi.fn(async () => 'personal-crate'),
		createWorkersSubdomain: vi.fn(),
		enableWorkerSubdomain: vi.fn(async () => {}),
	};
}

describe('provisionCloudflareDeployment', () => {
	it('reuses persisted resources and applies each versioned migration once', async () => {
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
		expect(api.queryD1).toHaveBeenCalledTimes(4);
		expect(api.uploadWorker).toHaveBeenCalledWith(expect.objectContaining({
			workerName: metadata.workerName,
			d1DatabaseId: metadata.d1DatabaseId,
			r2BucketName: metadata.r2BucketName,
		}));
		expect(api.enableWorkerSubdomain).toHaveBeenCalledTimes(1);
		expect(metadata.lastDeployedVersion).toBe('0.1.0');
		expect(workerUrl).toBe('https://crate-0123456789abcdef.personal-crate.workers.dev');
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
