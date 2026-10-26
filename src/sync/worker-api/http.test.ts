import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const requestUrl = vi.hoisted(() => vi.fn());
vi.mock('obsidian', async original => ({ ...await original<object>(), requestUrl }));
import { obsidianHttpTransport, WorkerApiHttpClient } from './http';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol/server-info';

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
