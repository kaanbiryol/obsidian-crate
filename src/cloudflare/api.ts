/**
 * Cloudflare API helpers for in-plugin setup and infrastructure management.
 */

import { requestUrl } from 'obsidian';

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

interface CloudflareEnvelope<T> {
	success: boolean;
	errors?: Array<{ message?: string }>;
	result: T;
}

interface CloudflareErrorBody {
	success?: boolean;
	errors?: Array<{ message?: string }>;
}

interface RawRequestOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	contentType?: string;
}

export interface CloudflareCredentials {
	accountId: string;
	apiToken: string;
}

export interface R2Bucket {
	name: string;
	creation_date: string;
}

export interface WorkerScript {
	id: string;
}

export interface D1Database {
	uuid: string;
	name: string;
}

export interface WorkerDeployment {
	id: string;
	url: string;
}

export interface DeployWorkerBindings {
	r2Bucket: string;
	authToken: string;
	d1DatabaseId?: string;
	accountId?: string;
	workerName?: string;
	bucketName?: string;
}

function formatCloudflareError(status: number, body: unknown): Error {
	if (body && typeof body === 'object') {
		const errorBody = body as CloudflareErrorBody;
		if (Array.isArray(errorBody.errors) && errorBody.errors.length > 0) {
			const message = errorBody.errors
				.map(e => e.message || 'Unknown Cloudflare API error')
				.join(', ');
			return new Error(`Cloudflare API error (${status}): ${message}`);
		}
	}

	return new Error(`Cloudflare API request failed with status ${status}`);
}

async function cfRawRequest(
	credentials: CloudflareCredentials,
	path: string,
	options: RawRequestOptions = {}
): Promise<unknown> {
	const response = await requestUrl({
		url: `${CF_API_BASE}${path}`,
		method: options.method ?? 'GET',
		headers: {
			Authorization: `Bearer ${credentials.apiToken}`,
			...(options.headers || {}),
		},
		contentType: options.contentType,
		body: options.body,
		throw: false,
	});

	if (response.status >= 400) {
		throw formatCloudflareError(response.status, response.json);
	}

	return response.json as unknown;
}

async function cfRequestVoid(
	credentials: CloudflareCredentials,
	path: string,
	options: RawRequestOptions = {}
): Promise<void> {
	await cfRawRequest(credentials, path, options);
}

async function cfRequest<T>(
	credentials: CloudflareCredentials,
	path: string,
	options: RawRequestOptions = {}
): Promise<T> {
	const json = await cfRawRequest(credentials, path, {
		contentType: options.contentType || 'application/json',
		...options,
	});

	if (!json || typeof json !== 'object') {
		throw new Error('Cloudflare API returned an invalid response');
	}

	const payload = json as CloudflareEnvelope<T>;
	if (!payload.success) {
		throw formatCloudflareError(200, payload);
	}

	return payload.result;
}

function randomBoundary(): string {
	return `----crate-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

function createMultipartBody(parts: Array<{
	name: string;
	value: string;
	filename?: string;
	contentType?: string;
}>): { body: string; boundary: string } {
	const boundary = randomBoundary();
	const lines: string[] = [];

	for (const part of parts) {
		lines.push(`--${boundary}`);
		const disposition = part.filename
			? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"`
			: `Content-Disposition: form-data; name="${part.name}"`;
		lines.push(disposition);
		if (part.contentType) {
			lines.push(`Content-Type: ${part.contentType}`);
		}
		lines.push('');
		lines.push(part.value);
	}

	lines.push(`--${boundary}--`);
	lines.push('');

	return {
		body: lines.join('\r\n'),
		boundary,
	};
}

export async function verifyCredentials(credentials: CloudflareCredentials): Promise<boolean> {
	try {
		await cfRequest<{ id: string }>(credentials, '/user');
		return true;
	} catch {
		return false;
	}
}

export async function listR2Buckets(credentials: CloudflareCredentials): Promise<R2Bucket[]> {
	const result = await cfRequest<{ buckets: R2Bucket[] }>(
		credentials,
		`/accounts/${credentials.accountId}/r2/buckets`
	);
	return result.buckets;
}

export async function createR2Bucket(credentials: CloudflareCredentials, bucketName: string): Promise<R2Bucket> {
	return cfRequest<R2Bucket>(
		credentials,
		`/accounts/${credentials.accountId}/r2/buckets`,
		{
			method: 'POST',
			body: JSON.stringify({ name: bucketName }),
		}
	);
}

export async function deleteR2Bucket(credentials: CloudflareCredentials, name: string): Promise<void> {
	await cfRequestVoid(
		credentials,
		`/accounts/${credentials.accountId}/r2/buckets/${name}`,
		{ method: 'DELETE' }
	);
}

export async function createD1Database(
	credentials: CloudflareCredentials,
	name: string
): Promise<{ uuid: string }> {
	return cfRequest<{ uuid: string }>(
		credentials,
		`/accounts/${credentials.accountId}/d1/database`,
		{
			method: 'POST',
			body: JSON.stringify({ name }),
		}
	);
}

export async function listD1Databases(credentials: CloudflareCredentials): Promise<D1Database[]> {
	return cfRequest<D1Database[]>(
		credentials,
		`/accounts/${credentials.accountId}/d1/database`
	);
}

export async function deleteD1Database(credentials: CloudflareCredentials, uuid: string): Promise<void> {
	await cfRequestVoid(
		credentials,
		`/accounts/${credentials.accountId}/d1/database/${uuid}`,
		{ method: 'DELETE' }
	);
}

export async function listWorkers(credentials: CloudflareCredentials): Promise<WorkerScript[]> {
	return cfRequest<WorkerScript[]>(
		credentials,
		`/accounts/${credentials.accountId}/workers/scripts`
	);
}

export async function deleteWorker(credentials: CloudflareCredentials, name: string): Promise<void> {
	await cfRequestVoid(
		credentials,
		`/accounts/${credentials.accountId}/workers/scripts/${name}`,
		{ method: 'DELETE' }
	);
}

export async function getWorkerSubdomain(credentials: CloudflareCredentials): Promise<string> {
	const result = await cfRequest<{ subdomain: string }>(
		credentials,
		`/accounts/${credentials.accountId}/workers/subdomain`
	);
	return result.subdomain;
}

export async function deployWorker(
	credentials: CloudflareCredentials,
	workerName: string,
	workerScript: string,
	bindings: DeployWorkerBindings
): Promise<WorkerDeployment> {
	const bindingsArray: Record<string, string>[] = [
		{
			type: 'r2_bucket',
			name: 'BUCKET',
			bucket_name: bindings.r2Bucket,
		},
		{
			type: 'secret_text',
			name: 'AUTH_TOKEN',
			text: bindings.authToken,
		},
	];

	if (bindings.d1DatabaseId) {
		bindingsArray.push({
			type: 'd1',
			name: 'DB',
			id: bindings.d1DatabaseId,
		});
		bindingsArray.push({
			type: 'plain_text',
			name: 'CF_DATABASE_ID',
			text: bindings.d1DatabaseId,
		});
	}

	if (bindings.accountId) {
		bindingsArray.push({
			type: 'plain_text',
			name: 'CF_ACCOUNT_ID',
			text: bindings.accountId,
		});
	}

	if (bindings.workerName) {
		bindingsArray.push({
			type: 'plain_text',
			name: 'CF_WORKER_NAME',
			text: bindings.workerName,
		});
	}

	if (bindings.bucketName) {
		bindingsArray.push({
			type: 'plain_text',
			name: 'CF_BUCKET_NAME',
			text: bindings.bucketName,
		});
	}

	bindingsArray.push({
		type: 'durable_object_namespace',
		name: 'REMINDER_ALARMS',
		class_name: 'ReminderAlarm',
	});

	const metadata = {
		main_module: 'index.js',
		bindings: bindingsArray,
		migrations: {
			tag: 'v1',
			new_sqlite_classes: ['ReminderAlarm'],
		},
	};

	const multipart = createMultipartBody([
		{
			name: 'metadata',
			value: JSON.stringify(metadata),
			contentType: 'application/json',
		},
		{
			name: 'index.js',
			filename: 'index.js',
			value: workerScript,
			contentType: 'application/javascript+module',
		},
	]);

	const deployJson = await cfRawRequest(
		credentials,
		`/accounts/${credentials.accountId}/workers/scripts/${workerName}`,
		{
			method: 'PUT',
			headers: {
				'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
			},
			body: multipart.body,
		}
	);

	if (!deployJson || typeof deployJson !== 'object') {
		throw new Error('Worker deployment returned an invalid response');
	}

	const deployData = deployJson as CloudflareEnvelope<{ id: string }>;
	if (!deployData.success) {
		throw formatCloudflareError(200, deployData);
	}

	await cfRequest<unknown>(
		credentials,
		`/accounts/${credentials.accountId}/workers/scripts/${workerName}/subdomain`,
		{
			method: 'POST',
			body: JSON.stringify({ enabled: true }),
		}
	);

	const subdomain = await getWorkerSubdomain(credentials);

	return {
		id: deployData.result.id,
		url: `https://${workerName}.${subdomain}.workers.dev`,
	};
}

export async function redeployWorker(
	credentials: CloudflareCredentials,
	workerName: string,
	workerScript: string
): Promise<void> {
	const metadata = {
		main_module: 'index.js',
		keep_bindings: ['r2_bucket', 'secret_text', 'd1', 'plain_text', 'durable_object_namespace'],
	};

	const multipart = createMultipartBody([
		{
			name: 'metadata',
			value: JSON.stringify(metadata),
			contentType: 'application/json',
		},
		{
			name: 'index.js',
			filename: 'index.js',
			value: workerScript,
			contentType: 'application/javascript+module',
		},
	]);

	const json = await cfRawRequest(
		credentials,
		`/accounts/${credentials.accountId}/workers/scripts/${workerName}`,
		{
			method: 'PUT',
			headers: {
				'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
			},
			body: multipart.body,
		}
	);

	if (!json || typeof json !== 'object') {
		throw new Error('Worker redeploy returned an invalid response');
	}

	const payload = json as CloudflareEnvelope<{ id?: string }>;
	if (!payload.success) {
		throw formatCloudflareError(200, payload);
	}
}

export interface WorkerBinding {
	type: string;
	name: string;
	text?: string;
	bucket_name?: string;
	id?: string;
}

export async function getWorkerBindings(
	credentials: CloudflareCredentials,
	workerName: string
): Promise<WorkerBinding[]> {
	const result = await cfRequest<{ bindings: WorkerBinding[] }>(
		credentials,
		`/accounts/${credentials.accountId}/workers/scripts/${workerName}/settings`
	);
	return result.bindings;
}

export function generateAuthToken(): string {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function generateBucketName(prefix: string = 'crate'): string {
	const randomSuffix = Math.random().toString(36).substring(2, 10);
	return `${prefix}-${randomSuffix}`;
}

export function generateWorkerName(prefix: string = 'crate-sync'): string {
	const randomSuffix = Math.random().toString(36).substring(2, 8);
	return `${prefix}-${randomSuffix}`;
}
