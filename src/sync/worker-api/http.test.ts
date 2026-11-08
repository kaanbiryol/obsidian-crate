import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const requestUrl = vi.hoisted(() => vi.fn());
vi.mock('obsidian', async original => ({ ...await original<object>(), requestUrl }));
import { obsidianHttpTransport, WorkerApiHttpClient } from './http';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol/server-info';
import { configureSyncLogger } from '../logger';

beforeEach(() => vi.stubGlobal('window', { setTimeout, clearTimeout }));
afterEach(() => vi.unstubAllGlobals());

it('returns a binary download without decoding its body as text', async () => {
	const info = JSON.stringify({ service: 'crate', serverVersion: 'test', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: [] });
	const body = new Uint8Array([0, 1, 2, 255]).buffer;
	let textReads = 0;
	requestUrl.mockImplementation(async ({ url }: { url: string }) => url.endsWith('/.well-known/crate')
		? { status: 200, headers: {}, arrayBuffer: new TextEncoder().encode(info).buffer, text: info }
		: { status: 200, headers: {}, arrayBuffer: body, get text() { textReads++; return ''; } });
	const http = new WorkerApiHttpClient('https://worker.example', 'token', obsidianHttpTransport);

	const download = await http.requestBinary('/sync/download?path=a.bin');

	expect(download.body).toBe(body);
	// Before: the transport copied `text` for every response.
	expect(textReads).toBe(0);
});

it('logs a request without its query, which can name a vault file', async () => {
	const info = JSON.stringify({ service: 'crate', serverVersion: 'test', protocol: CRATE_PLUGIN_PROTOCOL, capabilities: [] });
	const missing = JSON.stringify({ error: 'Not found' });
	requestUrl.mockImplementation(async ({ url }: { url: string }) => url.endsWith('/.well-known/crate')
		? { status: 200, headers: {}, arrayBuffer: new TextEncoder().encode(info).buffer, text: info }
		: { status: 404, headers: {}, arrayBuffer: new TextEncoder().encode(missing).buffer, text: missing });
	const logs = [vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'debug').mockImplementation(() => {})];
	configureSyncLogger({ enabled: true });
	try {
		const http = new WorkerApiHttpClient('https://worker.example', 'token', obsidianHttpTransport);
		await expect(http.requestBinary('/sync/download?path=notes%2Fprivate.md')).rejects.toThrow('Not found');

		const lines = logs.flatMap(spy => spy.mock.calls.map(call => call.join(' ')));
		expect(lines).toContainEqual(expect.stringContaining('Request failed: GET /sync/download -> Not found'));
		expect(lines.filter(line => line.includes('private'))).toEqual([]);
	} finally {
		configureSyncLogger({ enabled: false });
		for (const spy of logs) spy.mockRestore();
	}
});
