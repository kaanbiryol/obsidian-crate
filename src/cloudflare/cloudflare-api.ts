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
}

export interface CloudflareWorkerSettings {
	annotations?: {
		'workers/message'?: string;
		'workers/tag'?: string;
	};
	bindings?: CloudflareWorkerBinding[];
}

interface R2Bucket {
	name?: string;
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
	artifacts: CloudflareDeploymentArtifacts;
	d1DatabaseId: string;
	r2BucketName: string;
}): { body: ArrayBuffer; contentType: string } {
	const boundary = `crate-${randomBase64Url(18)}`;
	const encoder = new TextEncoder();
	const metadata = {
		main_module: 'worker.mjs',
		compatibility_date: '2026-08-18',
		annotations: {
			'workers/message': `Crate ${input.artifacts.version} ${input.artifacts.fingerprint}`,
			'workers/tag': 'crate',
		},
		bindings: [
				{ type: 'd1', name: 'DB', id: input.d1DatabaseId },
				{ type: 'r2_bucket', name: 'BUCKET', bucket_name: input.r2BucketName },
				{ type: 'durable_object_namespace', name: 'REMINDER_ALARMS', class_name: 'ReminderAlarm' },
			],
		exports: {
			ReminderAlarm: { type: 'durable-object', storage: 'sqlite', state: 'created' },
			SetupCoordinator: { type: 'durable-object', state: 'deleted' },
		},
	};
	const parts = [
		encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n`),
		encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="worker.mjs"; filename="worker.mjs"\r\nContent-Type: application/javascript+module\r\n\r\n`),
		encoder.encode(input.artifacts.workerBundle),
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
		return result
			.filter(item => item.status === 'accepted' && item.account?.id && item.account.name)
			.map(item => ({ id: item.account!.id!, name: item.account!.name! }));
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

	async findD1Database(accountId: string, name: string): Promise<D1Database | null> {
		const result = await this.request<D1Database[]>(
			`/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}&per_page=100`,
		);
		return result.find(database => database.name === name) ?? null;
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

	async queryD1(
		accountId: string,
		databaseId: string,
		sql: string,
		params?: string[],
	): Promise<D1QueryResult[]> {
		const body = params === undefined ? { sql } : { sql, params };
		return this.request(`/accounts/${accountId}/d1/database/${databaseId}/query`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
	}

	async uploadWorker(input: {
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
		return envelope.result;
	}
}
