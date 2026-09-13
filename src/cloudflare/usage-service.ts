import type { HttpTransport } from './http';

export interface UsageMetric {
	label: string;
	used: number;
	allowance?: number;
	bytes?: boolean;
}

export interface UsageGroup {
	label: string;
	metrics: UsageMetric[];
	error?: string;
}

const CLASS_A = new Set(['ListBuckets', 'PutBucket', 'ListObjects', 'ListBucket', 'PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload', 'LifecycleStorageTierTransition', 'ListMultipartUploads', 'UploadPart', 'UploadPartCopy', 'ListParts', 'PutBucketEncryption', 'PutBucketCors', 'PutBucketLifecycleConfiguration']);
const CLASS_B = new Set(['HeadBucket', 'HeadObject', 'GetObject', 'UsageSummary', 'GetBucketEncryption', 'GetBucketLocation', 'GetBucketCors', 'GetBucketLifecycleConfiguration']);
const FREE = new Set(['DeleteObject', 'DeleteBucket', 'AbortMultipartUpload']);
const LIMIT = 10000;

type Row = { sum?: Record<string, unknown>; max?: Record<string, unknown>; dimensions?: Record<string, unknown> };

function number(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new Error('Cloudflare returned incomplete usage data.');
	}
	return value;
}

/** On-demand account totals; no resource filters that could understate shared usage. */
export async function fetchCloudflareUsage(
	transport: HttpTransport, token: string, accountId: string, now = new Date(),
): Promise<UsageGroup[]> {
	const today = now.toISOString().slice(0, 10);
	const monthStart = `${today.slice(0, 8)}01T00:00:00Z`;
	const daily = `date_geq: ${JSON.stringify(today)}, date_leq: ${JSON.stringify(today)}`;
	const monthly = `datetime_geq: ${JSON.stringify(monthStart)}, datetime_leq: ${JSON.stringify(now.toISOString())}`;
	async function query(dataset: string, filter: string, fields: string): Promise<Row[]> {
		const response = await transport('https://api.cloudflare.com/client/v4/graphql', {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ query: `query { viewer { accounts(filter: { accountTag: ${JSON.stringify(accountId)} }) {
				usage: ${dataset}(limit: ${LIMIT}, filter: { ${filter} }) { ${fields} }
			} } }` }),
		});
		if (response.status === 401 || response.status === 403) throw new Error('Reconnect Cloudflare usage and authorize analytics for this account.');
		if (response.status < 200 || response.status >= 300) throw new Error(`Cloudflare usage is unavailable (HTTP ${response.status}). Try again later.`);
		const result = JSON.parse(response.text) as { errors?: unknown[]; data?: { viewer?: { accounts?: { usage?: Row[] }[] } } };
		if (result.errors?.length) throw new Error('Cloudflare could not provide this metric. Check analytics permissions and availability.');
		const rows = result.data?.viewer?.accounts?.[0]?.usage;
		if (!Array.isArray(rows) || rows.length >= LIMIT) throw new Error('Cloudflare returned incomplete usage data.');
		return rows;
	}
	const sum = (rows: Row[], field: string) => rows.reduce((total, row) => total + number(row.sum?.[field]), 0);
	const jobs: { label: string; load: () => Promise<UsageMetric[]> }[] = [
		{ label: 'Workers · today (UTC)', load: async () => {
			const rows = await query('workersInvocationsAdaptive', daily, 'sum { requests }');
			return [{ label: 'Requests', used: sum(rows, 'requests'), allowance: 100_000 }];
		} },
		{ label: 'D1 · today (UTC)', load: async () => {
			const rows = await query('d1AnalyticsAdaptiveGroups', daily, 'sum { rowsRead rowsWritten }');
			return [
				{ label: 'Rows read', used: sum(rows, 'rowsRead'), allowance: 5_000_000 },
				{ label: 'Rows written', used: sum(rows, 'rowsWritten'), allowance: 100_000 },
			];
		} },
		{ label: 'R2 · this calendar month (UTC)', load: async () => {
			const rows = await query('r2OperationsAdaptiveGroups', monthly, 'dimensions { actionType } sum { requests }');
			let a = 0, b = 0;
			for (const row of rows) {
				const action = row.dimensions?.actionType;
				if (typeof action !== 'string') throw new Error('Cloudflare returned incomplete operation data.');
				const count = number(row.sum?.requests);
				if (CLASS_A.has(action)) a += count;
				else if (CLASS_B.has(action)) b += count;
				else if (!FREE.has(action) && count > 0) throw new Error('Cloudflare reported unrecognized operations; remaining allowance is unavailable.');
			}
			return [
				{ label: 'Class A operations', used: a, allowance: 1_000_000 },
				{ label: 'Class B operations', used: b, allowance: 10_000_000 },
			];
		} },
		{ label: 'Storage · sum of today’s resource peaks', load: async () => {
			const results = await Promise.allSettled([
				query('d1StorageAdaptiveGroups', daily, 'dimensions { databaseId } max { databaseSizeBytes }'),
				query('r2StorageAdaptiveGroups', daily, 'dimensions { bucketName } max { payloadSize metadataSize }'),
			]);
			return results.map((result, i) => {
				if (result.status === 'rejected') throw new Error('Storage metrics are unavailable. Try again later.');
				if (!result.value.length) throw new Error('No storage samples available yet.');
				return { label: i === 0 ? 'D1 storage' : 'R2 storage', bytes: true,
					used: result.value.reduce((total, row) => total + (i === 0 ? number(row.max?.databaseSizeBytes) : number(row.max?.payloadSize) + number(row.max?.metadataSize)), 0) };
			});
		} },
	];
	return Promise.all(jobs.map(async ({ label, load }) => {
		try { return { label, metrics: await load() }; }
		catch (error) { return { label, metrics: [], error: error instanceof Error ? error.message : 'Usage unavailable. Try again later.' }; }
	}));
}
