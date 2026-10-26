import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkerApiHttpClient, type ApiHttpTransport } from './http';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol/server-info';

beforeEach(() => vi.stubGlobal('window', { setTimeout, clearTimeout }));
afterEach(() => vi.unstubAllGlobals());
function response(value: unknown) {
	const text = JSON.stringify(value);
	return { status: 200, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer };
}
function harness() {
	const transport = vi.fn<ApiHttpTransport>(async () => response({
		service: 'crate', serverVersion: 'test', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: [],
	}));
	return { transport, http: new WorkerApiHttpClient('https://old.example', 'old-token', transport) };
}

it('rejects a mutation prepared before changing the sync signal, even with cached metadata', async () => {
	const { http, transport } = harness();
	await http.getServerInfo();
	transport.mockClear();
	const writing = http.requestJson('/sync/batch-upload', { method: 'POST', body: '{}' });
	http.setAbortSignal(new AbortController().signal);
	await expect(writing).rejects.toMatchObject({ name: 'AbortError' });
	expect(transport).not.toHaveBeenCalled();
	await http.requestJson('/sync/batch-upload', { method: 'POST', body: '{}' });
	expect(transport).toHaveBeenCalledTimes(2);
	const dispatched = transport.mock.lastCall?.[0];
	expect(dispatched?.url).toBe('https://old.example/sync/batch-upload');
	expect(dispatched?.headers?.Authorization).toBe('Bearer old-token');
});

// Replacing credentials stops the old engine, which aborts its client's signal, and connects a new client.
it('rejects a mutation prepared before its sync lifecycle aborts, even with cached metadata', async () => {
	const { http, transport } = harness();
	const lifecycle = new AbortController();
	http.setAbortSignal(lifecycle.signal);
	await http.getServerInfo();
	transport.mockClear();
	const writing = http.requestJson('/sync/batch-upload', { method: 'POST', body: '{}' });
	lifecycle.abort();
	await expect(writing).rejects.toMatchObject({ name: 'AbortError' });
	expect(transport).not.toHaveBeenCalled();
});

for (const kind of ['json', 'binary'] as const) it.each(['success', 'http error', 'network error'] as const)(`rejects an old ${kind} %s after the sync signal changes`, async outcome => {
	const { http, transport } = harness();
	let release!: () => void;
	transport.mockImplementationOnce(async () => {
		await new Promise<void>(resolve => { release = resolve; });
		if (outcome === 'network error') throw new Error('Old connection failed');
		if (outcome === 'http error') return { ...response({ error: 'Old credential expired' }), status: 401 };
		return response({ old: true });
	});
	const reading = kind === 'json' ? http.requestJson('/sync/manifest') : http.requestBinary('/sync/download');
	http.setAbortSignal(new AbortController().signal);
	release();
	await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
});
