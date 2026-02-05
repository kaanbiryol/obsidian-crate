/**
 * Cloudflare API helpers for deploying R2 buckets and Workers
 */

export interface CloudflareCredentials {
	accountId: string;
	apiToken: string;
}

export interface R2Bucket {
	name: string;
	creation_date: string;
}

export interface WorkerDeployment {
	id: string;
	url: string;
}

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

async function cfFetch<T>(
	credentials: CloudflareCredentials,
	path: string,
	options: RequestInit = {}
): Promise<T> {
	const response = await fetch(`${CF_API_BASE}${path}`, {
		...options,
		headers: {
			'Authorization': `Bearer ${credentials.apiToken}`,
			'Content-Type': 'application/json',
			...options.headers,
		},
	});

	const data = await response.json() as { success: boolean; errors: Array<{ message: string }>; result: T };

	if (!data.success) {
		const errorMessage = data.errors?.map(e => e.message).join(', ') || 'Unknown Cloudflare API error';
		throw new Error(`Cloudflare API error: ${errorMessage}`);
	}

	return data.result;
}

export async function verifyCredentials(credentials: CloudflareCredentials): Promise<boolean> {
	try {
		// Try /user first (works for both OAuth tokens and API tokens)
		await cfFetch<{ id: string }>(credentials, '/user');
		return true;
	} catch {
		return false;
	}
}

export async function listR2Buckets(credentials: CloudflareCredentials): Promise<R2Bucket[]> {
	const result = await cfFetch<{ buckets: R2Bucket[] }>(
		credentials,
		`/accounts/${credentials.accountId}/r2/buckets`
	);
	return result.buckets;
}

export async function createR2Bucket(
	credentials: CloudflareCredentials,
	bucketName: string
): Promise<R2Bucket> {
	return cfFetch<R2Bucket>(
		credentials,
		`/accounts/${credentials.accountId}/r2/buckets`,
		{
			method: 'POST',
			body: JSON.stringify({ name: bucketName }),
		}
	);
}

export async function deployWorker(
	credentials: CloudflareCredentials,
	workerName: string,
	workerScript: string,
	bindings: { r2Bucket: string; authToken: string }
): Promise<WorkerDeployment> {
	// Create the worker script with R2 binding
	const metadata = {
		main_module: 'index.js',
		bindings: [
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
		],
	};

	// Deploy using multipart form data
	const formData = new FormData();
	formData.append('metadata', JSON.stringify(metadata));
	formData.append(
		'index.js',
		new Blob([workerScript], { type: 'application/javascript+module' }),
		'index.js'
	);

	const response = await fetch(
		`${CF_API_BASE}/accounts/${credentials.accountId}/workers/scripts/${workerName}`,
		{
			method: 'PUT',
			headers: {
				'Authorization': `Bearer ${credentials.apiToken}`,
			},
			body: formData,
		}
	);

	const data = await response.json() as { success: boolean; errors: Array<{ message: string }>; result: { id: string } };

	if (!data.success) {
		const errorMessage = data.errors?.map(e => e.message).join(', ') || 'Unknown error';
		throw new Error(`Failed to deploy worker: ${errorMessage}`);
	}

	// Enable the workers.dev subdomain for the worker
	await cfFetch<unknown>(
		credentials,
		`/accounts/${credentials.accountId}/workers/scripts/${workerName}/subdomain`,
		{
			method: 'POST',
			body: JSON.stringify({ enabled: true }),
		}
	);

	// Get the subdomain
	const subdomainResult = await cfFetch<{ subdomain: string }>(
		credentials,
		`/accounts/${credentials.accountId}/workers/subdomain`
	);

	return {
		id: data.result.id,
		url: `https://${workerName}.${subdomainResult.subdomain}.workers.dev`,
	};
}

export async function getWorkerSubdomain(credentials: CloudflareCredentials): Promise<string> {
	const result = await cfFetch<{ subdomain: string }>(
		credentials,
		`/accounts/${credentials.accountId}/workers/subdomain`
	);
	return result.subdomain;
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
