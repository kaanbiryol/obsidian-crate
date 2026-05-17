import type {
	CloudflareCredentials,
	D1Database,
	R2Bucket,
	WorkerBinding,
	WorkerScript,
} from './api-types';
import { cfRequest, cfRequestVoid } from './api-transport';

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

export async function queryD1(
	credentials: CloudflareCredentials,
	databaseId: string,
	sql: string,
	params?: string[]
): Promise<void> {
	await cfRequest<unknown>(
		credentials,
		`/accounts/${credentials.accountId}/d1/database/${databaseId}/query`,
		{ method: 'POST', body: JSON.stringify({ sql, params }) }
	);
}
