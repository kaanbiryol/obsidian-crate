import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CRATE_PLUGIN_PROTOCOL } from '../../protocol/server-info';
import { WorkerApiHttpClient, type ApiHttpResponse, type ApiHttpTransport } from './http';
import { InitialImportApi } from './initial-import';
import { SyncWorkerApi } from './sync';

const MIB = 1024 * 1024;
const hash = 'a'.repeat(64);

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal('window', { setTimeout, clearTimeout });
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function json(value: unknown, headers: Record<string, string> = {}): ApiHttpResponse {
	const text = JSON.stringify(value);
	return { status: 200, headers, text, arrayBuffer: new TextEncoder().encode(text).buffer };
}

/** A slow link: every transfer request answers only after `seconds`. */
function slowHttp(seconds: number, answer: (url: string) => ApiHttpResponse) {
	const transport = vi.fn<ApiHttpTransport>(async request => {
		if (request.url.endsWith('/.well-known/crate')) {
			return json({ service: 'crate', serverVersion: 'test', serverRevision: 4, protocol: CRATE_PLUGIN_PROTOCOL, reminderOperationDay: Math.floor(Date.now() / 86400000), capabilities: [] });
		}
		await new Promise(resolve => setTimeout(resolve, seconds * 1000));
		return answer(request.url);
	});
	return new WorkerApiHttpClient('https://worker.example', 'token', transport);
}
const slowApi = (seconds: number, answer: (url: string) => ApiHttpResponse) => new SyncWorkerApi(slowHttp(seconds, answer));

async function settle<T>(request: Promise<T>, seconds: number): Promise<PromiseSettledResult<T>> {
	const settled = Promise.allSettled([request]);
	await vi.advanceTimersByTimeAsync(seconds * 1000);
	return (await settled)[0];
}

// A journaled upload that cannot finish inside its timeout is replayed before every
// later sync, so a fixed limit would stop all sync on a slow uplink.
it('gives a large upload time to finish on a slow uplink', async () => {
	const api = slowApi(130, () => json({ success: true, path: 'memo.m4a', hash, revision: 'r1' }));
	const upload = api.uploadFile('memo.m4a', new ArrayBuffer(20 * MIB), hash, 20 * MIB, 'audio/mp4', null);
	expect(await settle(upload, 131)).toMatchObject({ status: 'fulfilled', value: { success: true } });
});

it('gives a full batch upload time to finish on a slow uplink', async () => {
	const files = ['a.png', 'b.png', 'c.png', 'd.png'].map(path => ({ path, content: 'A'.repeat(1_200_000), hash, size: 900_000, contentType: 'image/png', expectedHash: null }));
	const api = slowApi(130, () => json({ success: true, results: files.map(file => ({ success: true, path: file.path, hash, revision: 'r1' })) }));
	expect(await settle(api.batchUpload(files), 131)).toMatchObject({ status: 'fulfilled', value: { success: true } });
});

it('gives a large download of known size time to finish, and keeps the base limit otherwise', async () => {
	const body = (): ApiHttpResponse => ({ status: 200, headers: { 'Content-Length': String(20 * MIB) }, text: '', arrayBuffer: new ArrayBuffer(20 * MIB) });
	expect(await settle(slowApi(130, body).downloadFile('memo.m4a', 20 * MIB), 131)).toMatchObject({ status: 'fulfilled' });
	expect(await settle(slowApi(130, body).downloadFile('memo.m4a'), 131)).toMatchObject({ status: 'rejected', reason: { name: 'SyncTransportError' } });
});

it('gives a large first-upload file time to finish on a slow uplink', async () => {
	const imports = new InitialImportApi(slowHttp(130, () => json({ success: true, results: [{ success: true, path: 'memo.m4a', hash, revision: 'r1' }] })));
	const upload = imports.upload('token', [{ path: 'memo.m4a', content: new ArrayBuffer(20 * MIB), hash, size: 20 * MIB, contentType: 'audio/mp4', expectedHash: null }]);
	expect(await settle(upload, 131)).toMatchObject({ status: 'fulfilled', value: { success: true } });
});

it('keeps the base limit for a small upload', async () => {
	const api = slowApi(130, () => json({ success: true, path: 'note.md', hash, revision: 'r1' }));
	expect(await settle(api.uploadFile('note.md', new ArrayBuffer(10), hash, 10, 'text/markdown', null), 131))
		.toMatchObject({ status: 'rejected', reason: { name: 'SyncTransportError' } });
});
