import { describe, expect, it, vi } from 'vitest';
import { discoverCloudflareDeployments, parseReleaseWorkerMessage, releaseWorkerMessage } from './discovery';
import { isUploadTag, newUploadTag } from './fence';

describe('discoverCloudflareDeployments', () => {
	it('finds Crate Workers by their resource name and bindings', async () => {
		const api = {
			listWorkers: vi.fn(async () => [
				{ id: 'unrelated-worker', modified_on: '2026-08-23T08:00:00.000Z' },
				{ id: 'crate-0123456789abcdef', modified_on: '2026-08-23T09:00:00.000Z' },
			]),
			getWorkerSettings: vi.fn(async () => ({
				annotations: { 'workers/message': `Crate 0.1.0 ${'f'.repeat(64)}` },
				bindings: [
					{ type: 'd1', name: 'DB', id: 'database-id' },
					{ type: 'plain_text', name: 'CRATE_VAULT_NAME', text: 'Notes' },
					{ type: 'r2_bucket', name: 'BUCKET', bucket_name: 'crate-0123456789abcdef' },
					{ type: 'durable_object_namespace', name: 'REMINDER_ALARMS', class_name: 'ReminderAlarm' },
				],
			})),
		};

		const result = await discoverCloudflareDeployments(api, {
			id: 'account-id',
			name: 'Personal',
		});

		expect(result).toEqual([{
			metadata: {
				deploymentId: '0123456789abcdef',
				vaultName: 'Notes',
				accountId: 'account-id',
				accountName: 'Personal',
				workerName: 'crate-0123456789abcdef',
				d1DatabaseName: 'crate-0123456789abcdef',
				d1DatabaseId: 'database-id',
				r2BucketName: 'crate-0123456789abcdef',
				workersSubdomain: null,
				lastDeployedVersion: '0.1.0',
				lastDeployedFingerprint: 'f'.repeat(64),
			},
			modifiedOn: '2026-08-23T09:00:00.000Z',
		}]);
		expect(api.getWorkerSettings).toHaveBeenCalledTimes(1);
	});

	it('ignores similarly named Workers without Crate storage bindings', async () => {
		const api = {
			listWorkers: vi.fn(async () => [{ id: 'crate-0123456789abcdef' }]),
			getWorkerSettings: vi.fn(async () => ({ bindings: [] })),
		};

		await expect(discoverCloudflareDeployments(api as never, {
			id: 'account-id',
			name: 'Personal',
		})).resolves.toEqual([]);
	});

	it('does not treat a failed discovery request as permission to create a duplicate server', async () => {
		const api = {
			listWorkers: vi.fn(async () => [{ id: 'crate-0123456789abcdef' }]),
			getWorkerSettings: vi.fn(async () => {
				throw new Error('Cloudflare settings unavailable');
			}),
		};

		await expect(discoverCloudflareDeployments(api as never, {
			id: 'account-id',
			name: 'Personal',
		})).rejects.toThrow('Cloudflare settings unavailable');
	});
});

describe('upload identity formats', () => {
	it('reads back exactly the release message and upload tag Crate writes', () => {
		const fingerprint = 'a'.repeat(64);
		expect(parseReleaseWorkerMessage(releaseWorkerMessage('1.2.3', fingerprint))).toEqual({ version: '1.2.3', fingerprint });
		expect(parseReleaseWorkerMessage(`Crate 1.2.3 ${fingerprint} extra`)).toBeNull();
		expect(parseReleaseWorkerMessage('Crate 1.2 abc')).toBeNull();
		expect(isUploadTag(newUploadTag())).toBe(true);
		expect(isUploadTag('crate-not-a-tag')).toBe(false);
	});
});
