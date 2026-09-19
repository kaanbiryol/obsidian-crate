import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncApiClient } from './api';
import type { ApiHttpTransport } from './worker-api/http';

beforeEach(() => vi.stubGlobal('window', { setTimeout, clearTimeout }));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function response(value: unknown, status = 200) {
	const text = JSON.stringify(value);
	return { status, text, arrayBuffer: new TextEncoder().encode(text).buffer, headers: {} };
}

describe('plugin page title transport', () => {
	it('sends only the pasted URL in an authenticated POST without probing compatibility', async () => {
		const transport = vi.fn<ApiHttpTransport>().mockResolvedValue(response({ title: 'Article &amp; notes' }));
		const client = new SyncApiClient('https://crate.example', 'device-secret', transport);
		const url = 'https://example.com/日本語?q=a&token=private#fragment';
		await expect(client.fetchPageTitle(url)).resolves.toBe('Article &amp; notes');
		expect(transport).toHaveBeenCalledOnce();
		expect(transport).toHaveBeenCalledWith(expect.objectContaining({
			url: 'https://crate.example/links/title', method: 'POST', body: JSON.stringify({ url }), contentType: 'application/json',
		}));
		expect(transport.mock.calls[0]?.[0].headers?.Authorization).toBe('Bearer device-secret');
		expect(JSON.stringify(client.getRequestDiagnostics())).not.toContain('private');
		expect(JSON.stringify(client.getRequestDiagnostics())).not.toContain('device-secret');
	});
	it.each([{}, { title: null }, { title: 123 }, { title: ['unexpected'] }])('returns no title for unsupported successful response %#', async value => {
		const client = new SyncApiClient('https://crate.example', 'token', vi.fn<ApiHttpTransport>().mockResolvedValue(response(value)));
		await expect(client.fetchPageTitle('https://example.com')).resolves.toBeNull();
	});
	it.each([401, 403, 404, 429, 503])('surfaces HTTP %i for the editor fallback without retrying', async status => {
		const transport = vi.fn<ApiHttpTransport>().mockResolvedValue(response({ error: 'Unavailable' }, status));
		const client = new SyncApiClient('https://crate.example', 'token', transport);
		await expect(client.fetchPageTitle('https://example.com')).rejects.toMatchObject({ status });
		expect(transport).toHaveBeenCalledOnce();
	});
	it('times out a stalled lookup after seven seconds and ignores its late response', async () => {
		vi.useFakeTimers(); vi.stubGlobal('window', { setTimeout, clearTimeout });
		let finish!: (value: ReturnType<typeof response>) => void;
		const transport = vi.fn<ApiHttpTransport>(() => new Promise(resolve => { finish = resolve; }));
		const client = new SyncApiClient('https://crate.example', 'token', transport);
		const result = client.fetchPageTitle('https://example.com');
		const rejected = expect(result).rejects.toThrow('7000ms');
		await vi.advanceTimersByTimeAsync(7000); await rejected;
		finish(response({ title: 'Too late' })); await Promise.resolve();
		expect(transport).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
	});
	it('does not dispatch after the plugin transport has been aborted', async () => {
		const transport = vi.fn<ApiHttpTransport>(); const client = new SyncApiClient('https://crate.example', 'token', transport);
		const abort = new AbortController(); abort.abort(); client.setAbortSignal(abort.signal);
		await expect(client.fetchPageTitle('https://example.com')).rejects.toMatchObject({ name: 'AbortError' });
		expect(transport).not.toHaveBeenCalled();
	});
});
