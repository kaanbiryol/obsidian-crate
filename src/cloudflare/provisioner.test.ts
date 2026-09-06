import { describe, expect, it, vi } from 'vitest';
import type { CloudflareDeploymentMetadata } from './deployment-types';
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
		getWorkerSettings: vi.fn(async () => ({ annotations: { 'workers/message': 'Crate 0.1.0' } })),
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
	it('rejects a newer remote Worker before changing schema or uploading code', async () => {
		const api = createApi();
		api.getWorkerSettings.mockResolvedValue({ annotations: { 'workers/message': 'Crate 9.0.0' } });
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
		expect(api.queryD1).toHaveBeenCalledTimes(7);
		expect(api.queryD1).toHaveBeenNthCalledWith(
			3,
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

	it('applies a pending migration before reconciling an existing schema', async () => {
		const api = createApi();
		api.queryD1
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ results: [{ name: 'files' }] }])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ results: [{ name: '0001_initial.sql' }] }])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([]);
		const metadata = createMetadata();
		const migrations = [
			{ name: '0002_launch_hardening.sql', sql: 'ALTER TABLE files ADD COLUMN portable_path TEXT;', sha256: 'hash' },
		];

		await provisionCloudflareDeployment({
			api: api as never,
			accountId: metadata.accountId!,
			metadata,
			artifacts: { ...artifacts, d1Migrations: migrations },
			onMetadataChanged: vi.fn(async () => {}),
		});

		expect(api.queryD1).toHaveBeenNthCalledWith(
			6,
			metadata.accountId,
			metadata.d1DatabaseId,
			"ALTER TABLE files ADD COLUMN portable_path TEXT;\nINSERT INTO d1_migrations (name) VALUES ('0002_launch_hardening.sql');",
		);
		expect(api.queryD1).toHaveBeenNthCalledWith(
			7,
			metadata.accountId,
			metadata.d1DatabaseId,
			artifacts.d1Schema,
		);
		expect(api.uploadWorker).toHaveBeenCalledOnce();
		expect(api.queryD1).toHaveBeenCalledTimes(11);
	});

	it('records launch hardening without rerunning it when the schema is already current', async () => {
		const api = createApi();
		api.queryD1
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ results: [{ name: 'files' }] }])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ results: [{ name: '0001_initial.sql' }] }])
			.mockResolvedValueOnce([{ results: [
				{ name: 'portable_path' },
				{ name: 'disabled_at' },
				{ name: 'last_error' },
				{ name: 'notification_jobs' },
				{ name: 'file_versions' },
				{ name: 'maintenance_state' },
			] }])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([]);
		const metadata = createMetadata();
		const migrations = [
			{ name: '0002_launch_hardening.sql', sql: 'ALTER TABLE files ADD COLUMN portable_path TEXT;', sha256: 'hash' },
		];

		await provisionCloudflareDeployment({
			api: api as never,
			accountId: metadata.accountId!,
			metadata,
			artifacts: { ...artifacts, d1Migrations: migrations },
			onMetadataChanged: vi.fn(async () => {}),
		});

		expect(api.queryD1).toHaveBeenNthCalledWith(
			6,
			metadata.accountId,
			metadata.d1DatabaseId,
			"INSERT INTO d1_migrations (name) VALUES ('0002_launch_hardening.sql');",
		);
		expect(api.queryD1).not.toHaveBeenCalledWith(
			metadata.accountId,
			metadata.d1DatabaseId,
			expect.stringContaining('ALTER TABLE files'),
		);
	});

	it('records embedded migrations after creating the complete schema for a fresh database', async () => {
		const api = createApi();
		const metadata = createMetadata();
		const migrations = [
			{ name: '0002_launch_hardening.sql', sql: 'ALTER TABLE files ADD COLUMN portable_path TEXT;', sha256: 'hash' },
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
			artifacts.d1Schema,
		);
		expect(api.queryD1).toHaveBeenNthCalledWith(
			4,
			metadata.accountId,
			metadata.d1DatabaseId,
			"INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0002_launch_hardening.sql');",
		);
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
