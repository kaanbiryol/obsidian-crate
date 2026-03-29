import { requestUrl } from 'obsidian';
import type { UsageResponse, WorkerConfig } from '../plugin/types';
import type { SyncApiClient } from '../sync/api';

const CLASS_A_ACTIONS = [
	'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload',
	'UploadPart', 'UploadPartCopy', 'ListMultipartUploads', 'ListParts',
	'ListBucket', 'ListBucketMultipartUploads', 'ListBucketVersions',
];

export class CloudflareUsageService {
	async getUsage(analyticsToken: string | null, apiClient: SyncApiClient | null): Promise<UsageResponse> {
		if (!analyticsToken || !apiClient) {
			return { available: false };
		}

		try {
			const config = await apiClient.getConfig();
			if (!config.accountId || !config.workerName || !config.bucketName) {
				return { available: false, error: 'Worker config incomplete' };
			}

			return await this.queryAnalytics(analyticsToken, config);
		} catch (error) {
			return { available: false, error: error instanceof Error ? error.message : 'Failed to fetch usage data' };
		}
	}

	private async queryAnalytics(token: string, config: WorkerConfig): Promise<UsageResponse> {
		const now = new Date();
		const today = now.toISOString().split('T')[0]!;
		const monthStart = today.substring(0, 8) + '01';

		const hasDatabase = Boolean(config.databaseId);
		const d1Fragment = hasDatabase ? `
			d1Analytics: d1AnalyticsAdaptiveGroups(
				filter: { databaseId: $databaseId, date_geq: $today, date_leq: $today }
				limit: 1
			) {
				sum { readQueries writeQueries }
			}
			d1Storage: d1StorageAdaptiveGroups(
				filter: { databaseId: $databaseId, date_geq: $today, date_leq: $today }
				limit: 1
			) {
				max { databaseSizeBytes }
			}
		` : '';

		const query = `query UsageMetrics(
			$accountId: String!,
			$workerName: String!,
			$bucketName: String!,
			$today: String!,
			$monthStart: String!,
			$databaseId: String
		) {
			viewer {
				accounts(filter: { accountTag: $accountId }) {
					workersInvocationsAdaptive(
						filter: { scriptName: $workerName, date_geq: $today, date_leq: $today }
						limit: 1
					) {
						sum { requests }
					}
					r2Storage: r2StorageAdaptiveGroups(
						filter: { bucketName: $bucketName, date_geq: $today, date_leq: $today }
						limit: 1
					) {
						max { payloadSize metadataSize }
					}
					r2Ops: r2OperationsAdaptiveGroups(
						filter: { bucketName: $bucketName, date_geq: $monthStart, date_leq: $today }
						limit: 100
						orderBy: [sum_requests_DESC]
					) {
						dimensions { actionType }
						sum { requests }
					}
					${d1Fragment}
				}
			}
		}`;

		const gqlResponse = await requestUrl({
			url: 'https://api.cloudflare.com/client/v4/graphql',
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				query,
				variables: {
					accountId: config.accountId,
					workerName: config.workerName,
					bucketName: config.bucketName,
					today,
					monthStart,
					databaseId: config.databaseId || null,
				},
			}),
		});

		const gqlData = gqlResponse.json as {
			errors?: Array<{ message: string }>;
			data?: {
				viewer?: {
					accounts?: Array<{
						workersInvocationsAdaptive?: Array<{ sum?: { requests?: number } }>;
						r2Storage?: Array<{ max?: { payloadSize?: number; metadataSize?: number } }>;
						r2Ops?: Array<{ dimensions?: { actionType?: string }; sum?: { requests?: number } }>;
						d1Analytics?: Array<{ sum?: { readQueries?: number; writeQueries?: number } }>;
						d1Storage?: Array<{ max?: { databaseSizeBytes?: number } }>;
					}>;
				};
			};
		};

		if (gqlData.errors && gqlData.errors.length > 0) {
			return { available: true, error: gqlData.errors[0]!.message };
		}

		const account = gqlData.data?.viewer?.accounts?.[0];
		if (!account) {
			return { available: true, error: 'No account data returned' };
		}

		const workerRequests = account.workersInvocationsAdaptive?.[0]?.sum?.requests || 0;
		const r2StorageRaw = account.r2Storage?.[0]?.max;
		const r2StorageBytes = (r2StorageRaw?.payloadSize || 0) + (r2StorageRaw?.metadataSize || 0);

		let classAOps = 0;
		let classBOps = 0;
		for (const entry of (account.r2Ops || [])) {
			const action = entry.dimensions?.actionType || '';
			const count = entry.sum?.requests || 0;
			if (CLASS_A_ACTIONS.includes(action)) {
				classAOps += count;
			} else {
				classBOps += count;
			}
		}

		const result: UsageResponse = {
			available: true,
			workers: {
				requests: { current: workerRequests, limit: 100000, unit: 'requests' },
			},
			r2: {
				storageBytes: { current: r2StorageBytes, limit: 10 * 1024 * 1024 * 1024, unit: 'bytes' },
				classAOps: { current: classAOps, limit: 1000000, unit: 'requests' },
				classBOps: { current: classBOps, limit: 10000000, unit: 'requests' },
			},
			queriedAt: now.toISOString(),
		};

		if (config.databaseId) {
			const d1A = account.d1Analytics?.[0]?.sum;
			const d1S = account.d1Storage?.[0]?.max;
			result.d1 = {
				rowsRead: { current: d1A?.readQueries || 0, limit: 5000000, unit: 'rows' },
				rowsWritten: { current: d1A?.writeQueries || 0, limit: 100000, unit: 'rows' },
				storageBytes: { current: d1S?.databaseSizeBytes || 0, limit: 5 * 1024 * 1024 * 1024, unit: 'bytes' },
			};
		}

		return result;
	}
}
