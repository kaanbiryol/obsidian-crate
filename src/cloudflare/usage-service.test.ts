import { describe, expect, it, vi } from 'vitest';
import * as obsidian from 'obsidian';
import type { SyncApiClient } from '../sync/api';
import { CloudflareUsageService } from './usage-service';

describe('CloudflareUsageService', () => {
	it('sends analytics queries with GraphQL variables instead of interpolating config values', async () => {
		const requestUrlSpy = vi.spyOn(obsidian, 'requestUrl').mockResolvedValue({
			json: {
				data: {
					viewer: {
						accounts: [{
							workersInvocationsAdaptive: [{ sum: { requests: 12 } }],
							r2Storage: [{ max: { payloadSize: 10, metadataSize: 5 } }],
							r2Ops: [{ dimensions: { actionType: 'PutObject' }, sum: { requests: 3 } }],
							d1Analytics: [{ sum: { readQueries: 2, writeQueries: 1 } }],
							d1Storage: [{ max: { databaseSizeBytes: 99 } }],
						}],
					},
				},
			},
		} as never);

		const apiClient = {
			getConfig: vi.fn().mockResolvedValue({
				accountId: 'acct-"quoted"',
				workerName: 'worker-"}-name',
				bucketName: 'bucket-${oops}',
				databaseId: 'db-id',
			}),
		} as unknown as SyncApiClient;

		const service = new CloudflareUsageService();
		const result = await service.getUsage('analytics-token', apiClient);

		expect(result.available).toBe(true);
		const request = requestUrlSpy.mock.calls[0]?.[0];
		if (!request || typeof request === 'string') {
			throw new Error('Expected requestUrl to be called with a request object');
		}
		if (typeof request.body !== 'string') {
			throw new Error('Expected request body to be a JSON string');
		}
		const body = JSON.parse(request.body) as {
			query: string;
			variables: Record<string, unknown>;
		};
		expect(body.query).toContain('$accountId');
		expect(body.query).not.toContain('acct-"quoted"');
		expect(body.variables).toMatchObject({
			accountId: 'acct-"quoted"',
			workerName: 'worker-"}-name',
			bucketName: 'bucket-${oops}',
			databaseId: 'db-id',
		});
	});
});
