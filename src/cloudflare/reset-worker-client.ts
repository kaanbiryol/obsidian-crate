import { CloudflareApiError } from './cloudflare-api';
import { sha256Hex } from './deployment-artifacts';
import type { HttpTransport } from './http';

function cleanupUrl(origin: string, path: string): string {
	const url = new URL(origin);
	if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash
		|| !/^crate-[a-f0-9]{16}\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname)) throw new Error('Invalid cleanup Worker address.');
	return `${url.origin}${path}`;
}

function info(text: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(text);
		return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
	} catch { return null; }
}

export async function verifyResetWorker(transport: HttpTransport, origin: string, resetId: string): Promise<void> {
	const url = cleanupUrl(origin, '/.well-known/crate-reset');
	// Publication can be visible in the management API before the public route.
	for (let attempt = 0; attempt < 5; attempt++) {
		const response = await transport(url, { method: 'GET', headers: { 'Cache-Control': 'no-cache' } });
		const value = info(response.text);
		if (response.status === 200 && value?.service === 'crate-reset' && value.protocol === 1 && value.resetId === resetId) return;
		if (attempt < 4) await new Promise(resolve => window.setTimeout(resolve, 500 * (attempt + 1)));
	}
	throw new Error('The cleanup Worker is not ready yet. Retry the server deletion or reset.');
}

export async function deleteResetWorkerObjects(transport: HttpTransport, origin: string, resetId: string, token: string, keys: string[]): Promise<void> {
	const url = cleanupUrl(origin, '/__crate__/reset/objects');
	if (!/^[a-f0-9]{64}$/.test(token) || !/^[a-f0-9]{32}$/.test(resetId) || !keys.length || keys.length > 1000
		|| new Set(keys).size !== keys.length || keys.some(key => !key || new TextEncoder().encode(key).length > 1024
			|| key.split('/').some(segment => segment === '.' || segment === '..'))) throw new Error('Invalid cleanup batch.');
	const body = JSON.stringify(keys);
	// Use only the short-lived, batch-scoped cleanup capability, never the account token.
	const response = await transport(url, { method: 'POST', body,
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
	if (response.status !== 200) throw new CloudflareApiError(`Remote file cleanup failed with HTTP ${response.status}`, response.status, null);
	const value = info(response.text);
	if (value?.service !== 'crate-reset' || value.protocol !== 1 || value.resetId !== resetId
		|| value.batchHash !== await sha256Hex(body) || value.deleted !== keys.length) throw new Error('The remote file cleanup result could not be verified.');
}
