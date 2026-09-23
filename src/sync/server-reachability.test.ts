import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CRATE_PLUGIN_PROTOCOL } from '../protocol';
import { checkServerReachability } from './server-reachability';

const serverInfo = { service: 'crate', serverVersion: 'dev', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: ['sync-v3'] };
const signal = () => new AbortController().signal;

beforeEach(() => vi.stubGlobal('window', globalThis));
afterEach(() => vi.unstubAllGlobals());

describe('server reachability probe', () => {
	it('accepts a reachable Crate server without credentials', async () => {
		const fetcher = vi.fn(async () => new Response(JSON.stringify(serverInfo)));
		vi.stubGlobal('fetch', fetcher);
		await expect(checkServerReachability('https://crate.example/', signal())).resolves.toBeNull();
		expect(fetcher).toHaveBeenCalledExactlyOnceWith('https://crate.example/.well-known/crate', expect.objectContaining({ cache: 'no-store' }));
	});

	it('reports a missing temporary tunnel address', async () => {
		const fetcher = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
		vi.stubGlobal('fetch', fetcher);
		await expect(checkServerReachability('https://old.trycloudflare.com', signal())).resolves.toContain('latest HTTPS address');
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it('does not mistake a proxy without CORS headers for downtime', async () => {
		const fetcher = vi.fn()
			.mockRejectedValueOnce(new TypeError('Failed to fetch'))
			.mockResolvedValueOnce(new Response(null, { status: 200 }));
		vi.stubGlobal('fetch', fetcher);
		await expect(checkServerReachability('https://crate.example', signal())).resolves.toBeNull();
		expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ mode: 'no-cors' });
	});

	it('reports an unreachable tunnel origin and a wrong server', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 502 })));
		await expect(checkServerReachability('https://old.trycloudflare.com', signal())).resolves.toContain('tunnel cannot reach Crate');
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ service: 'other' }))));
		await expect(checkServerReachability('https://crate.example', signal())).resolves.toContain('did not return a Crate server');
	});
});
