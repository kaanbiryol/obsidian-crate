import { NOTIFICATION_RATE_BINDING, notificationRateNamespace } from './notification-rate-binding';
import type { CloudflareDeploymentArtifacts } from './deployment-artifacts';
import type { HttpRequest, HttpTransport } from './http';
import { randomBase64Url } from './pkce';

const API_BASE_URL = 'https://api.cloudflare.com/client/v4';

interface CloudflareErrorShape {
	code?: number;
	message?: string;
}

interface CloudflareEnvelope<T> {
	success: boolean;
	result: T;
	errors?: CloudflareErrorShape[];
	result_info?: Record<string, unknown>;
}

export interface CloudflareAccount {
	id: string;
	name: string;
}

interface D1Database {
	uuid?: string;
	name?: string;
}

export interface CloudflareWorkerScript {
	id?: string;
	created_on?: string;
	modified_on?: string;
}

export interface CloudflareWorkerBinding {
	type?: string;
	name?: string;
	id?: string;
	bucket_name?: string;
	class_name?: string;
	namespace_id?: string;
	script_name?: string;
	service?: string;
}

export interface CloudflareWorkerSettings {
	annotations?: {
		'workers/message'?: string;
		'workers/tag'?: string;
	};
	bindings?: CloudflareWorkerBinding[];
}

export interface DurableObjectNamespace {
	id?: string;
	class?: string;
	script?: string;
}

interface R2Bucket {
	name?: string;
	creation_date?: string;
}

interface D1QueryResult {
	results?: Array<Record<string, unknown>>;
	success?: boolean;
}

export class CloudflareApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: number | null,
	) {
		super(message);
		this.name = 'CloudflareApiError';
	}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function asEnvelope<T>(value: unknown): CloudflareEnvelope<T> | null {
	if (typeof value !== 'object' || value === null || !('success' in value)) return null;
	return value as CloudflareEnvelope<T>;
}

function concatBytes(parts: Uint8Array[]): ArrayBuffer {
	const length = parts.reduce((total, part) => total + part.byteLength, 0);
	const output = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output.buffer;
}

export function buildWorkerMultipartBody(input: {
	publicOrigin: string;
	artifacts: CloudflareDeploymentArtifacts;
	d1DatabaseId: string;
	r2BucketName: string;
}): { body: ArrayBuffer; contentType: string } {
	const metadata = {
		main_module: 'worker.mjs',
		compatibility_date: '2026-08-18',
		annotations: {
			'workers/message': `Crate ${input.artifacts.version} ${input.artifacts.fingerprint}`,
			'workers/tag': 'crate',
		},
		bindings: [
				{ type: 'plain_text', name: 'CRATE_PUBLIC_ORIGIN', text: new URL(input.publicOrigin).origin },
				{ type: 'd1', name: 'DB', id: input.d1DatabaseId },
				{ type: 'r2_bucket', name: 'BUCKET', bucket_name: input.r2BucketName },
				{ type: 'durable_object_namespace', name: 'REMINDER_ALARMS', class_name: 'ReminderAlarm' },
				{ type: 'ratelimit', name: NOTIFICATION_RATE_BINDING, namespace_id: notificationRateNamespace(input.r2BucketName), simple: { limit: 60, period: 60 } },
			],
		exports: {
			ReminderAlarm: { type: 'durable-object', storage: 'sqlite', state: 'created' },
		},
	};
	return buildWorkerModule(metadata, input.artifacts.workerBundle);
}

export function buildResetWorkerMultipartBody(resetId: string, databaseId: string, bucketName: string): { body: ArrayBuffer; contentType: string } {
	return buildWorkerModule({
		main_module: 'worker.mjs', compatibility_date: '2026-08-18',
		annotations: { 'workers/message': `Crate reset ${resetId}`, 'workers/tag': 'crate' },
		bindings: [{ type: 'd1', name: 'DB', id: databaseId }, { type: 'r2_bucket', name: 'BUCKET', bucket_name: bucketName }],
		exports: { ReminderAlarm: { type: 'durable-object', state: 'deleted' } },
	}, 'export default { fetch() { return new Response("Crate server reset in progress", { status: 503 }); }, scheduled() {} };');
}

function buildWorkerModule(metadata: Record<string, unknown>, workerBundle: string): { body: ArrayBuffer; contentType: string } {
	const boundary = `crate-${randomBase64Url(18)}`;
	const encoder = new TextEncoder();
	const parts = [
		encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n`),
		encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="worker.mjs"; filename="worker.mjs"\r\nContent-Type: application/javascript+module\r\n\r\n`),
		encoder.encode(workerBundle),
		encoder.encode(`\r\n--${boundary}--\r\n`),
	];
	return {
		body: concatBytes(parts),
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}

export class CloudflareApiClient {
	constructor(
		private readonly accessToken: string,
		private readonly transport: HttpTransport,
	) {}

	async listAuthorizedAccounts(): Promise<CloudflareAccount[]> {
		const result = await this.request<Array<{
			status?: string;
			account?: { id?: string; name?: string };
		}>>('/memberships?status=accepted&per_page=50');
		return result.flatMap(item => {
			const account = item.account;
			if (item.status !== 'accepted' || !account?.id || !account.name) {
				return [];
			}
			return [{ id: account.id, name: account.name }];
		});
	}

	async listWorkers(accountId: string): Promise<CloudflareWorkerScript[]> {
		return this.request<CloudflareWorkerScript[]>(`/accounts/${accountId}/workers/scripts`);
	}

	async getWorkerSettings(accountId: string, workerName: string): Promise<CloudflareWorkerSettings> {
		return this.request<CloudflareWorkerSettings>(
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/settings`,
		);
	}

	async getD1Database(accountId: string, databaseId: string): Promise<D1Database | null> {
		try {
			return await this.request<D1Database>(`/accounts/${accountId}/d1/database/${databaseId}`);
		} catch (error) {
			if (error instanceof CloudflareApiError && error.status === 404) return null;
			throw error;
		}
	}

	async deleteD1Database(accountId: string, databaseId: string): Promise<void> {
		await this.request(`/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}`, { method: 'DELETE' });
	}

	async findD1Database(accountId: string, name: string): Promise<D1Database | null> {
		const result = await this.request<D1Database[]>(
			`/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}&per_page=100`,
		);
		const matches = result.filter(database => database.name === name);
		if (matches.length > 1) throw new Error('Multiple D1 databases match this deployment name. Select the intended server before deploying.');
		return matches[0] ?? null;
	}

	async createD1Database(accountId: string, name: string): Promise<D1Database> {
		return this.request(`/accounts/${accountId}/d1/database`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name }),
		});
	}

	async getR2Bucket(accountId: string, name: string): Promise<R2Bucket | null> {
		try {
			return await this.request<R2Bucket>(`/accounts/${accountId}/r2/buckets/${encodeURIComponent(name)}`);
		} catch (error) {
			if (error instanceof CloudflareApiError && error.status === 404) return null;
			throw error;
		}
	}

	async createR2Bucket(accountId: string, name: string): Promise<R2Bucket> {
		return this.request(`/accounts/${accountId}/r2/buckets`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ name }),
		});
	}

	async listDurableObjectNamespaces(accountId: string): Promise<DurableObjectNamespace[]> {
		const namespaces: DurableObjectNamespace[] = [];
		const seen = new Set<string>();
		const invalid = () => new Error('Could not verify the complete Durable Object namespace listing.');
		for (let page = 1; page <= 10000; page++) {
			const response = await this.requestEnvelope<DurableObjectNamespace[]>(`/accounts/${accountId}/workers/durable_objects/namespaces?page=${page}&per_page=100`);
			const pages = response.result_info?.total_pages;
			const reportedPage = response.result_info?.page;
			if (!Array.isArray(response.result)
				|| (reportedPage !== undefined && reportedPage !== page)
				|| (pages !== undefined && (typeof pages !== 'number' || !Number.isSafeInteger(pages) || pages < 0))) {
				throw invalid();
			}
			for (const namespace of response.result) {
				if (!namespace || typeof namespace.id !== 'string' || !namespace.id || seen.has(namespace.id)) throw invalid();
				seen.add(namespace.id);
			}
			namespaces.push(...response.result);
			if (typeof pages === 'number') {
				if ((pages === 0 && namespaces.length > 0) || (pages > page && response.result.length === 0)) throw invalid();
				if (page >= pages) return namespaces;
			} else if (response.result.length === 0) {
				return namespaces;
			}
			// Pagination metadata is optional. Without a total, require an empty page,
			// rather than treating a short page as proof that the inventory is complete.
		}
		throw invalid();
	}

	async listR2Objects(accountId: string, bucketName: string, cursor?: string): Promise<{ keys: string[]; cursor?: string }> {
		const params = new URLSearchParams({ per_page: '1000' });
		if (cursor) params.set('cursor', cursor);
		const response = await this.requestEnvelope<Array<{ key?: string }>>(`/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects?${params}`);
		const info = response.result_info;
		const invalid = (reason: string) => new Error(`Could not verify the complete R2 object listing. ${reason}`);
		if (!Array.isArray(response.result) || response.result.some(object => !object || typeof object.key !== 'string' || !object.key)) {
			throw invalid('Cloudflare returned an invalid object list.');
		}
		if (info !== undefined && (!info || typeof info !== 'object' || Array.isArray(info))) {
			throw invalid('Cloudflare returned invalid pagination metadata.');
		}
		const next = info?.cursor;
		const truncated = info?.is_truncated;
		if ((next != null && typeof next !== 'string')
			|| (truncated !== undefined && typeof truncated !== 'boolean')) {
			throw invalid('Cloudflare returned invalid cursor or truncation metadata.');
		}
		if (truncated === true && !next) throw invalid('The page is truncated but has no continuation cursor.');
		if (truncated === false && next) throw invalid('The final page unexpectedly has a continuation cursor.');
		if (next && next === cursor) throw invalid('The continuation cursor did not advance.');
		// The REST API uses CursorPagination in Cloudflare's SDK: is_truncated
		// is optional; an absent/empty cursor ends the listing.
		return { keys: response.result.map(object => object.key!), ...(next ? { cursor: next } : {}) };
	}

	async deleteR2Object(accountId: string, bucketName: string, key: string): Promise<void> {
		if (key.split('/').some(segment => segment === '.' || segment === '..')) throw new Error('Unsafe R2 object key.');
		const objectPath = key.split('/').map(segment => encodeURIComponent(segment)).join('/');
		await this.request(`/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}/objects/${objectPath}`, { method: 'DELETE' });
	}

	async deleteR2Bucket(accountId: string, bucketName: string): Promise<void> {
		await this.request(`/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}`, { method: 'DELETE' });
	}

	async deleteWorker(accountId: string, workerName: string): Promise<void> {
		const response = await this.transport(`${API_BASE_URL}/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`, {
			method: 'DELETE', headers: { Authorization: `Bearer ${this.accessToken}` },
		});
		const envelope = asEnvelope<unknown>(parseJson(response.text));
		if (response.status < 200 || response.status >= 300 || (response.text.trim() && !envelope?.success)) {
			throw new CloudflareApiError(envelope?.errors?.[0]?.message || `Worker deletion failed with HTTP ${response.status}`, response.status, null);
		}
	}

	async retireCrateWorker(accountId: string, workerName: string, resetId: string, databaseId: string, bucketName: string): Promise<void> {
		const multipart = buildResetWorkerMultipartBody(resetId, databaseId, bucketName);
		await this.request(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}`, {
			method: 'PUT', headers: { 'Content-Type': multipart.contentType }, body: multipart.body,
		});
	}

	async queryD1(
		accountId: string,
		databaseId: string,
		sql: string,
		params?: string[],
	): Promise<D1QueryResult[]> {
		const body = params === undefined ? { sql } : { sql, params };
		const results = await this.request<D1QueryResult[]>(`/accounts/${accountId}/d1/database/${databaseId}/query`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (!Array.isArray(results) || results.some(result => result.success === false)) {
			throw new CloudflareApiError('Cloudflare D1 reported a failed SQL statement', 200, null);
		}
		return results;
	}

	async uploadWorker(input: {
		publicOrigin: string;
		accountId: string;
		workerName: string;
		artifacts: CloudflareDeploymentArtifacts;
		d1DatabaseId: string;
		r2BucketName: string;
	}): Promise<void> {
		const multipart = buildWorkerMultipartBody(input);
		await this.request(`/accounts/${input.accountId}/workers/scripts/${input.workerName}`, {
			method: 'PUT',
			headers: { 'Content-Type': multipart.contentType },
			body: multipart.body,
		});
	}

	async updateWorkerSchedules(accountId: string, workerName: string, crons: string[]): Promise<void> {
		await this.request(
			`/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/schedules`,
			{
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(crons.map((cron) => ({ cron }))),
			},
		);
	}

	async getWorkersSubdomain(accountId: string): Promise<string | null> {
		try {
			const result = await this.request<{ subdomain?: string }>(`/accounts/${accountId}/workers/subdomain`);
			return result.subdomain?.trim() || null;
		} catch (error) {
			if (error instanceof CloudflareApiError && error.status === 404) return null;
			throw error;
		}
	}

	async createWorkersSubdomain(accountId: string, subdomain: string): Promise<string> {
		const result = await this.request<{ subdomain?: string }>(`/accounts/${accountId}/workers/subdomain`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ subdomain }),
		});
		if (!result.subdomain) throw new Error('Cloudflare did not return the new workers.dev subdomain');
		return result.subdomain;
	}

	async enableWorkerSubdomain(accountId: string, workerName: string): Promise<void> {
		await this.request(`/accounts/${accountId}/workers/scripts/${workerName}/subdomain`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ enabled: true, previews_enabled: false }),
		});
	}

	private async request<T>(path: string, request: HttpRequest = { method: 'GET' }): Promise<T> {
		return (await this.requestEnvelope<T>(path, request)).result;
	}

	private async requestEnvelope<T>(path: string, request: HttpRequest = { method: 'GET' }): Promise<CloudflareEnvelope<T>> {
		const response = await this.transport(`${API_BASE_URL}${path}`, {
			...request,
			headers: {
				...request.headers,
				Authorization: `Bearer ${this.accessToken}`,
			},
		});
		const parsed = parseJson(response.text);
		const envelope = asEnvelope<T>(parsed);
		if (response.status < 200 || response.status >= 300 || !envelope?.success) {
			const firstError = envelope?.errors?.[0];
			throw new CloudflareApiError(
				firstError?.message || `Cloudflare request failed with HTTP ${response.status}`,
				response.status,
				typeof firstError?.code === 'number' ? firstError.code : null,
			);
		}
		return envelope;
	}
}
