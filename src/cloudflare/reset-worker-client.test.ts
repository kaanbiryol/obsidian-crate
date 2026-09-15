import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CloudflareApiClient } from './cloudflare-api';
import { sha256Hex } from './deployment-artifacts';
import type { HttpTransport } from './http';

const origin = 'https://crate-0123456789abcdef.example.workers.dev';
const resetId = 'a'.repeat(32), token = 'b'.repeat(64);
const keys = ['Notes/École #1.md', '__crate__/settings.json'];
beforeEach(() => vi.stubGlobal('window', globalThis));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const metadata = { service: 'crate-reset', protocol: 1, resetId };

it('sends a single bulk request with a cleanup credential and preserves exact keys', async () => {
	const response = { ...metadata, batchHash: await sha256Hex(JSON.stringify(keys)), deleted: keys.length };
	const transport = vi.fn<HttpTransport>(async () => ({ status: 200, text: JSON.stringify(response) }));
	await new CloudflareApiClient('account-management-secret', transport).deleteR2Objects(origin, resetId, token, keys);
	expect(transport).toHaveBeenCalledExactlyOnceWith(`${origin}/__crate__/reset/objects`, {
		method: 'POST', body: JSON.stringify(keys), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
	});
	expect(JSON.stringify(transport.mock.calls)).not.toContain('account-management-secret');
});

it.each([{ deleted: 1 }, { batchHash: 'wrong' }, { resetId: 'other' }, { protocol: 2 }, { service: 'other' }])('rejects mismatched bulk receipts: %j', async changed => {
	const response = { ...metadata, batchHash: await sha256Hex(JSON.stringify(keys)), deleted: keys.length, ...changed };
	const transport = vi.fn<HttpTransport>(async () => ({ status: 200, text: JSON.stringify(response) }));
	await expect(new CloudflareApiClient('account-secret', transport).deleteR2Objects(origin, resetId, token, keys)).rejects.toThrow('could not be verified');
	expect(transport).toHaveBeenCalledOnce();
});

it.each(['https://attacker.example', 'http://crate-0123456789abcdef.example.workers.dev', `${origin}/other`, `${origin}?query=yes`])('never sends credentials to an invalid origin: %s', async target => {
	const transport = vi.fn<HttpTransport>();
	await expect(new CloudflareApiClient('account-secret', transport).deleteR2Objects(target, resetId, token, keys)).rejects.toThrow('address');
	expect(transport).not.toHaveBeenCalled();
});

it.each([[], ['../../other'], ['duplicate', 'duplicate'], Array.from({ length: 1001 }, (_, i) => String(i))].map(keys => ({ keys })))('rejects invalid batches before dispatch (%#)', async ({ keys: batch }) => {
	const transport = vi.fn<HttpTransport>();
	await expect(new CloudflareApiClient('account-secret', transport).deleteR2Objects(origin, resetId, token, batch)).rejects.toThrow('Invalid cleanup batch');
	expect(transport).not.toHaveBeenCalled();
});

it('does not retry an uncertain bulk request', async () => {
	const transport = vi.fn<HttpTransport>().mockRejectedValue(new Error('lost response'));
	await expect(new CloudflareApiClient('account-secret', transport).deleteR2Objects(origin, resetId, token, keys)).rejects.toThrow('lost response');
	expect(transport).toHaveBeenCalledOnce();
});

it('waits for the matching retirement Worker without forwarding any credentials', async () => {
	vi.useFakeTimers();
	const transport = vi.fn<HttpTransport>()
		.mockResolvedValueOnce({ status: 503, text: 'old retirement Worker' })
		.mockResolvedValueOnce({ status: 200, text: JSON.stringify({ ...metadata, resetId: 'old' }) })
		.mockResolvedValue({ status: 200, text: JSON.stringify(metadata) });
	const operation = new CloudflareApiClient('account-secret', transport).verifyResetWorker(origin, resetId);
	await vi.runAllTimersAsync();
	await operation;
	expect(transport).toHaveBeenCalledTimes(3);
	for (const [url, request] of transport.mock.calls) {
		expect(url).toBe(`${origin}/.well-known/crate-reset`);
		expect(request).toEqual({ method: 'GET', headers: { 'Cache-Control': 'no-cache' } });
	}
});

it('bounds readiness retries when the old Worker keeps answering', async () => {
	vi.useFakeTimers();
	const transport = vi.fn<HttpTransport>().mockResolvedValue({ status: 503, text: 'old retirement Worker' });
	const operation = new CloudflareApiClient('account-secret', transport).verifyResetWorker(origin, resetId);
	const rejection = expect(operation).rejects.toThrow('not ready yet');
	await vi.runAllTimersAsync();
	await rejection;
	expect(transport).toHaveBeenCalledTimes(5);
});
