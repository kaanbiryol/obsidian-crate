import { CRATE_PLUGIN_PROTOCOL } from '../protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, SyncApiClient } from './api';
import type { ApiHttpResponse, ApiHttpTransport } from './worker-api/http';

function mockTransport(...responses: Response[]) {
  const explicitMetadata = responses.some(response => response.headers.get('X-Test-Metadata') === 'true');
	let responseIndex = 0;
	return vi.fn<ApiHttpTransport>(async request => {
    if (request.url.endsWith('/.well-known/crate') && !explicitMetadata) {
      const text = JSON.stringify({ service: 'crate', serverVersion: '0.1.0', protocol: CRATE_PLUGIN_PROTOCOL, reminderOperationDay: Math.floor(Date.now() / 86400000), capabilities: [] });
      return { status: 200, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer };
    }
		const response = responses[responseIndex++];
		if (!response) throw new Error('No mock response available');
		const arrayBuffer = await response.arrayBuffer();
		const headers: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			headers[key] = value;
		});
		return {
			status: response.status,
			headers,
			arrayBuffer,
			text: new TextDecoder().decode(arrayBuffer),
		};
	});
}

describe('SyncApiClient', () => {
	it('accepts sequential namespace replacements in history while validating the final manifest', async () => {
		const entry = { hash: 'a'.repeat(64), size: 1, modified: '2026-09-08', revision: 'r1' };
		const changes = [
			{ seq: 1, path: 'Projects.md', action: 'delete', hash: '', size: 0, created_at: '2026-09-08' },
			{ seq: 2, path: 'projects.md/child.md', action: 'put', hash: entry.hash, size: 1, created_at: '2026-09-08' },
		];
		const client = new SyncApiClient('https://worker.example', 'token', mockTransport(
			Response.json({ changes, lastSeq: 2, hasMore: false, cursorExpired: false }),
			Response.json({ version: 1, files: { 'Projects.md': entry }, snapshotSeq: 0, lastSeq: 0, hasMore: false, cursorExpired: false }),
			Response.json({ changes, lastSeq: 2, hasMore: false, cursorExpired: false }),
		));
		expect((await client.getChanges(0)).changes).toEqual(changes);
		expect(Object.keys((await client.getManifest()).files)).toEqual(['projects.md/child.md']);
	});

	it('refuses to apply an existing invalid ancestor/descendant manifest', async () => {
		const entry = { hash: 'a'.repeat(64), size: 1, modified: '2026-09-08', revision: 'r1' };
		const client = new SyncApiClient('https://worker.example', 'token', mockTransport(
			Response.json({ version: 1, files: { 'Projects.md': entry, 'projects.md/child.md': entry }, snapshotSeq: 2, lastSeq: 2, hasMore: false, cursorExpired: false }),
			Response.json({ changes: [], lastSeq: 2, hasMore: false, cursorExpired: false }),
		));
		await expect(client.getManifest()).rejects.toThrow('parent folder');
	});
	it.each(['abort', 'timeout'])('discovers a remotely committed upload after %s without accepting its late response', async reason => {
		vi.useFakeTimers();
		let commit!: () => void;
		const hash = 'a'.repeat(64);
		let remoteFiles: Record<string, { hash: string; size: number; modified: string; revision: string }> = {};
		const response = (data: unknown): ApiHttpResponse => {
			const text = JSON.stringify(data);
			return { status: 200, headers: {}, text, arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer };
		};
		const transport: ApiHttpTransport = async request => {
			if (request.url.endsWith('/.well-known/crate')) return response({ service: 'crate', serverVersion: '0.1.0', protocol: CRATE_PLUGIN_PROTOCOL, reminderOperationDay: Math.floor(Date.now() / 86400000), capabilities: [] });
      if (request.url.includes('/sync/upload')) {
				return new Promise(resolve => {
					commit = () => {
						remoteFiles = { 'note.md': { hash, size: 1, modified: '2026-01-01', revision: 'r1' } };
						resolve(response({ success: true, path: 'note.md', hash }));
					};
				});
			}
			return response({ files: remoteFiles });
		};
		const client = new SyncApiClient('https://worker.example', 'token', transport);
		const controller = new AbortController();
		client.setAbortSignal(controller.signal);
		let accepted = false;
		const upload = client.uploadFile('note.md', new ArrayBuffer(1), hash, 1, 'text/markdown', null);
		void upload.then(() => { accepted = true; }, () => {});
		const assertion = expect(upload).rejects.toThrow(reason === 'abort' ? 'Sync request aborted' : 'Request timed out');
		await vi.waitFor(() => expect(commit).toBeTypeOf('function'));
    if (reason === 'abort') controller.abort();
		else await vi.advanceTimersByTimeAsync(120_000);
		await assertion;
		commit();
		client.setAbortSignal(new AbortController().signal);
		const metadata = await client.getFileMetadata(['note.md']);
		expect(metadata.files['note.md']?.hash).toBe(hash);
		expect(accepted).toBe(false);
	});
	beforeEach(() => {
		vi.stubGlobal('window', {
			clearTimeout: (timeoutId: number) => clearTimeout(timeoutId),
			setTimeout: (callback: () => void, timeout: number) => setTimeout(callback, timeout),
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.resetAllMocks();
	});

	it('uses encoded paths and auth headers for requests', async () => {
		const transport = mockTransport(new Response(new Uint8Array([0]), {
			status: 200,
			headers: { 'Content-Type': 'text/plain', 'Content-Length': '1' },
		}));
		const client = new SyncApiClient('https://worker.example/', 'token-1', transport);

		const download = await client.downloadFile('folder/a b#.md');
		expect(download).toEqual({
			content: download.content,
			contentType: 'text/plain',
			hash: '',
			size: 1,
		});
		expect(download.content).toBeInstanceOf(ArrayBuffer);

		const [request] = transport.mock.calls[0]!;
		expect(request.url).toBe('https://worker.example/sync/download?path=folder%2Fa%20b%23.md');
		expect(request.method).toBeUndefined();
		expect(request.headers?.Authorization).toBe('Bearer token-1');
	});

	it('parses JSON error responses', async () => {
		const transport = mockTransport(new Response('{"error":"Unauthorized"}', { status: 401 }));
		const client = new SyncApiClient('https://worker.example', 'token', transport);
		await expect(client.health()).rejects.toThrow('Unauthorized');
	});

	it('preserves structured mutation conflict details', async () => {
		const transport = mockTransport(new Response(JSON.stringify({
			error: 'Remote file changed since it was read',
			code: 'version_conflict',
			currentHash: 'remote-hash',
		}), { status: 409 }));
		const client = new SyncApiClient('https://worker.example', 'token', transport);

		await expect(client.deleteFile('notes/a.md', 'base-hash', 'base-revision')).rejects.toMatchObject({
			status: 409,
			code: 'version_conflict',
			currentHash: 'remote-hash',
		});
	});

	it('falls back to HTTP status and body for non-JSON errors', async () => {
		const transport = mockTransport(new Response('Service unavailable', { status: 503 }));
		const client = new SyncApiClient('https://worker.example', 'token', transport);
		await expect(client.getManifest()).rejects.toThrow('HTTP 503: Service unavailable');
	});

	it('loads a paginated manifest and replays changes after its snapshot', async () => {
		const transport = mockTransport(
			new Response(JSON.stringify({
				version: 1,
				files: { 'notes/a.md': { hash: 'a'.repeat(64), size: 1, modified: '2026-01-01', revision: 'r1' } },
				lastSeq: 3,
				snapshotSeq: 3,
				hasMore: true,
				nextCursor: 'notes/a.md',
			})),
			new Response(JSON.stringify({
				version: 1,
				files: { 'notes/b.md': { hash: 'b'.repeat(64), size: 2, modified: '2026-01-02', revision: 'r1' } },
				lastSeq: 4,
				snapshotSeq: 3,
				hasMore: false, cursorExpired: false,
			})),
			new Response(JSON.stringify({
				changes: [
					{ seq: 4, path: 'notes/a.md', action: 'delete', hash: '', size: 0, created_at: '2026-01-04' },
					{ seq: 5, path: 'notes/c.md', action: 'put', hash: 'c'.repeat(64), size: 3, created_at: '2026-01-05' },
				],
				lastSeq: 5,
				hasMore: false, cursorExpired: false,
			})),
		);
		const client = new SyncApiClient('https://worker.example', 'token', transport);

		await expect(client.getManifest()).resolves.toEqual({
			version: 1,
			files: {
				'notes/b.md': { hash: 'b'.repeat(64), size: 2, modified: '2026-01-02', revision: 'r1' },
				'notes/c.md': { hash: 'c'.repeat(64), size: 3, modified: '2026-01-05' },
			},
			lastSeq: 5,
		});
		expect(transport.mock.calls.map(call => call[0].url)).toEqual([
			'https://worker.example/sync/manifest?limit=2000',
			'https://worker.example/sync/manifest?limit=2000&after=notes%2Fa.md&snapshotSeq=3',
			'https://worker.example/sync/changes?since=3',
		]);
	});

	it('loads metadata for only the requested sync paths', async () => {
		const transport = mockTransport(new Response(JSON.stringify({
			files: {
				'notes/a.md': { hash: 'a'.repeat(64), size: 4, modified: '2026-01-01', revision: 'r1' },
			},
		})));
		const client = new SyncApiClient('https://worker.example', 'token', transport);

		await expect(client.getFileMetadata(['notes/a.md', 'notes/missing.md'])).resolves.toEqual({
			files: {
				'notes/a.md': { hash: 'a'.repeat(64), size: 4, modified: '2026-01-01', revision: 'r1' },
			},
		});
		const [request] = transport.mock.calls[0]!;
		expect(request.url).toBe('https://worker.example/sync/metadata');
		expect(request.method).toBe('POST');
		expect(JSON.parse(request.body as string)).toEqual({ paths: ['notes/a.md', 'notes/missing.md'] });
	});

	it('chunks targeted metadata requests at the worker limit', async () => {
		const paths = Array.from({ length: 51 }, (_, index) => `notes/${index}.md`);
		const transport = mockTransport(
			new Response(JSON.stringify({ files: {} })),
			new Response(JSON.stringify({ files: {} })),
		);
		const client = new SyncApiClient('https://worker.example', 'token', transport);

		await expect(client.getFileMetadata(paths)).resolves.toEqual({ files: {} });
		expect(transport).toHaveBeenCalledTimes(2);
		const firstBody = JSON.parse(transport.mock.calls[0]![0].body as string) as { paths: string[] };
		const secondBody = JSON.parse(transport.mock.calls[1]![0].body as string) as { paths: string[] };
		expect(firstBody.paths).toHaveLength(50);
		expect(secondBody.paths).toEqual(['notes/50.md']);
	});

	it('falls back to the manifest when an older worker lacks targeted metadata', async () => {
		const transport = mockTransport(
			new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
			new Response(JSON.stringify({
				version: 1,
				files: {
					'notes/a.md': { hash: 'a'.repeat(64), size: 4, modified: '2026-01-01', revision: 'r1' },
					'notes/unrelated.md': { hash: 'd'.repeat(64), size: 5, modified: '2026-01-01', revision: 'r1' },
				},
				lastSeq: 3,
				snapshotSeq: 3,
				hasMore: false, cursorExpired: false,
			})),
			new Response(JSON.stringify({ changes: [], lastSeq: 3, snapshotSeq: 3, hasMore: false, cursorExpired: false })),
		);
		const client = new SyncApiClient('https://worker.example', 'token', transport);

		await expect(client.getFileMetadata(['notes/a.md'])).resolves.toEqual({
			files: {
				'notes/a.md': { hash: 'a'.repeat(64), size: 4, modified: '2026-01-01', revision: 'r1' },
			},
		});
		expect(transport).toHaveBeenCalledTimes(3);
	});

	it('updates credentials used by subsequent requests', async () => {
		const transport = mockTransport(new Response('{"status":"ok","timestamp":"now"}'));
		const client = new SyncApiClient('https://old.example/', 'old-token', transport);
		client.updateCredentials('https://new.example/', 'new-token');
		await client.health();

		const [request] = transport.mock.calls[0]!;
		expect(request.url).toBe('https://new.example/health');
		expect(request.headers?.Authorization).toBe('Bearer new-token');
		expect(client.getWorkerUrl()).toBe('https://new.example');
	});

	it('refreshes the shared-settings version after a stale write', async () => {
		const settings = {
			ignorePatterns: [],
			syncOnStartup: true,
			syncOnResume: true,
			syncInterval: 30,
			showStatusBar: true,
			pushEnabled: false,
		};
		const transport = mockTransport(
			new Response(JSON.stringify({ settings, settingsVersion: 'version-1' })),
			new Response(JSON.stringify({ error: 'Shared settings changed on another device' }), { status: 409 }),
			new Response(JSON.stringify({ settings, settingsVersion: 'version-2' })),
			new Response(JSON.stringify({ success: true, settingsVersion: 'version-3' })),
		);
		const client = new SyncApiClient('https://worker.example', 'token', transport);

		await expect(client.putSharedSettings(settings)).rejects.toMatchObject({ status: 409 });
		await expect(client.putSharedSettings(settings)).resolves.toMatchObject({ settingsVersion: 'version-3' });

		expect(transport.mock.calls.filter(call => call[0].url.endsWith('/settings')).map(call => call[0].url)).toEqual([
			'https://worker.example/settings',
			'https://worker.example/settings',
			'https://worker.example/settings',
			'https://worker.example/settings',
		]);
		const lastPut = transport.mock.calls.at(-1)?.[0];
		if (typeof lastPut?.body !== 'string') throw new Error('Expected a JSON request body');
		expect(JSON.parse(lastPut.body) as unknown).toMatchObject({ expectedVersion: 'version-2' });
	});

	it('rejects in-flight requests with an AbortError when the sync signal aborts', async () => {
		const transport = vi.fn<ApiHttpTransport>(() => new Promise<ApiHttpResponse>(() => {}));
		const controller = new AbortController();
		const client = new SyncApiClient('https://worker.example', 'token', transport);
		client.setAbortSignal(controller.signal);

		const request = client.health();
		controller.abort();

		await expect(request).rejects.toMatchObject({
			name: 'AbortError',
			message: 'Sync request aborted',
		});
	});

	it('rejects in-flight requests when the request timeout elapses', async () => {
		vi.useFakeTimers();
		const transport = vi.fn<ApiHttpTransport>(() => new Promise<ApiHttpResponse>(() => {}));
		const client = new SyncApiClient('https://worker.example', 'token', transport);

		const assertion = expect(client.health()).rejects.toThrow('Request timed out after 30000ms');
		await vi.advanceTimersByTimeAsync(30_000);

		await assertion;
	});

	it('returns user-friendly testConnection failure details', async () => {
		const transport = mockTransport(new Response('boom', { status: 500 }));
		const client = new SyncApiClient('https://worker.example', 'token', transport);
		await expect(client.testConnection()).resolves.toEqual({
			success: false,
			error: 'HTTP 500: boom',
		});
	});

	it('rejects a server with an incompatible protocol before the health check', async () => {
		const transport = mockTransport(new Response(JSON.stringify({
			service: 'crate',
			serverVersion: '9.0.0',
			protocol: { current: 9, oldestCompatible: 9 },
			capabilities: ['sync-v1'],
		}), { headers: { 'X-Test-Metadata': 'true' } }));
		const client = new SyncApiClient('https://worker.example', 'token', transport);
		await expect(client.testConnection()).resolves.toEqual({
			success: false,
			error: 'Incompatible Crate server protocol 9',
		});
		expect(transport).toHaveBeenCalledTimes(1);
	});

	it('rejects insecure non-local worker URLs', () => {
		const client = new SyncApiClient('http://worker.example', 'token');
		expect(client.isConfigured()).toBe(false);
	});

	it('throws HttpError with retryAfter on 429 with Retry-After header', async () => {
		const transport = mockTransport(new Response('{"error":"Too many requests"}', {
			status: 429,
			headers: { 'Retry-After': '30' },
		}));
		const client = new SyncApiClient('https://worker.example', 'token', transport);
		try {
			await client.health();
			expect.unreachable('Should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(HttpError);
			expect(error).toMatchObject({ status: 429, retryAfter: 30_000, message: 'Too many requests' });
		}
	});

	it('parses HTTP-date Retry-After headers', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const transport = mockTransport(new Response('{"error":"Too many requests"}', {
			status: 429,
			headers: { 'Retry-After': 'Thu, 01 Jan 2026 00:00:30 GMT' },
		}));
		const client = new SyncApiClient('https://worker.example', 'token', transport);
		try {
			await client.health();
			expect.unreachable('Should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(HttpError);
			expect((error as HttpError).retryAfter).toBe(30_000);
		}
	});

	it('throws HttpError with null retryAfter when no Retry-After header', async () => {
		const transport = mockTransport(new Response('{"error":"Server error"}', { status: 500 }));
		const client = new SyncApiClient('https://worker.example', 'token', transport);
		try {
			await client.health();
			expect.unreachable('Should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(HttpError);
			expect(error).toMatchObject({ status: 500, retryAfter: null });
		}
	});
});
