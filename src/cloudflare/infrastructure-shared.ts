import { requestUrl } from 'obsidian';
import type {
	CloudflareCredentials,
	WorkerBinding,
} from './api';
import { normalizeWorkerUrl } from '../sync/worker-url';

export function requireWorkerUrl(value: string): string {
	const normalized = normalizeWorkerUrl(value);
	if (!normalized) {
		throw new Error('Worker URL is invalid.');
	}
	return normalized;
}

export async function computeTokenHash(token: string): Promise<string> {
	const data = new TextEncoder().encode(token);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = new Uint8Array(hashBuffer);
	return Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function waitForWorkerReady(
	workerUrl: string,
	authToken: string,
	onProgress?: (message: string) => void
): Promise<void> {
	const baseUrl = requireWorkerUrl(workerUrl);
	const url = `${baseUrl}/health`;
	for (let attempt = 0; attempt < 10; attempt++) {
		try {
			const response = await requestUrl({
				url,
				method: 'GET',
				headers: { Authorization: `Bearer ${authToken}` },
				throw: false,
			});
			if (response.status === 200) return;
		} catch {
			// Worker not ready yet
		}
		onProgress?.(`Waiting for worker to become available (${attempt + 1}/10)...`);
		await sleep(2000);
	}
}

export async function registerTokenWithWorker(
	workerUrl: string,
	authToken: string,
	device?: {
		deviceId?: string;
		deviceName?: string;
		platform?: string;
	}
): Promise<void> {
	const baseUrl = requireWorkerUrl(workerUrl);
	const tokenHash = await computeTokenHash(authToken);
	try {
		await requestUrl({
			url: `${baseUrl}/auth/tokens`,
			method: 'POST',
			headers: {
				Authorization: `Bearer ${authToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				token_hash: tokenHash,
				device_id: device?.deviceId,
				device_name: device?.deviceName,
				platform: device?.platform,
			}),
		});
	} catch {
		// Best effort - AUTH_TOKEN binding provides fallback
	}
}

export function toCredentials(accountId: string, apiToken: string): CloudflareCredentials {
	return { accountId: accountId.trim(), apiToken: apiToken.trim() };
}

export function isBucketNotEmptyError(error: unknown): boolean {
	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	return message.includes('not empty') || message.includes('bucket not empty');
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveConfigFromBindings(
	bindings: WorkerBinding[]
): { bucketName: string; databaseId: string } | null {
	let bucketName: string | undefined;
	let databaseId: string | undefined;

	for (const binding of bindings) {
		if (binding.type === 'plain_text' && binding.name === 'CF_BUCKET_NAME' && binding.text) {
			bucketName = binding.text;
		}
		if (binding.type === 'plain_text' && binding.name === 'CF_DATABASE_ID' && binding.text) {
			databaseId = binding.text;
		}
	}

	if (!bucketName || !databaseId) return null;
	return { bucketName, databaseId };
}

export function collectResourcesFromWorkerBindings(
	bindings: WorkerBinding[],
	bucketNames: Set<string>,
	databaseIds: Set<string>
): void {
	for (const binding of bindings) {
		if (binding.type === 'plain_text' && binding.name === 'CF_BUCKET_NAME' && binding.text?.trim()) {
			bucketNames.add(binding.text.trim());
		}
		if (binding.type === 'plain_text' && binding.name === 'CF_DATABASE_ID' && binding.text?.trim()) {
			databaseIds.add(binding.text.trim());
		}
		if (binding.type === 'r2_bucket' && binding.bucket_name?.trim()) {
			bucketNames.add(binding.bucket_name.trim());
		}
		if (binding.type === 'd1' && binding.id?.trim()) {
			databaseIds.add(binding.id.trim());
		}
	}
}

export async function requestWorkerJson(
	url: string,
	authToken: string
): Promise<{ status: number; body: unknown }> {
	const response = await requestUrl({
		url,
		method: 'GET',
		headers: {
			Authorization: `Bearer ${authToken}`,
		},
		throw: false,
	});

	return {
		status: response.status,
		body: response.json as unknown,
	};
}
