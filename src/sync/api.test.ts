import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpError, SyncApiClient } from './api';

function mockFetch(response: Response) {
	const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response);
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

describe('SyncApiClient', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.resetAllMocks();
	});

	it('uses encoded paths and auth headers for requests', async () => {
		const fetchMock = mockFetch(new Response(new Uint8Array([0]), {
			status: 200,
			headers: { 'Content-Type': 'text/plain', 'Content-Length': '1' },
		}));
		const client = new SyncApiClient('https://worker.example/', 'token-1');

		const download = await client.downloadFile('folder/a b#.md');
		expect(download).toEqual({
			content: download.content,
			contentType: 'text/plain',
			hash: '',
			size: 1,
		});
		expect(download.content).toBeInstanceOf(ArrayBuffer);

		const [url, requestValue] = fetchMock.mock.calls[0]!;
		const request = requestValue as RequestInit;
		expect(url).toBe('https://worker.example/sync/download?path=folder%2Fa%20b%23.md');
		expect(request.method).toBeUndefined();
		expect((request.headers as Record<string, string>).Authorization).toBe('Bearer token-1');
	});

	it('parses JSON error responses', async () => {
		mockFetch(new Response('{"error":"Unauthorized"}', { status: 401 }));
		const client = new SyncApiClient('https://worker.example', 'token');
		await expect(client.health()).rejects.toThrow('Unauthorized');
	});

	it('falls back to HTTP status and body for non-JSON errors', async () => {
		mockFetch(new Response('Service unavailable', { status: 503 }));
		const client = new SyncApiClient('https://worker.example', 'token');
		await expect(client.getManifest()).rejects.toThrow('HTTP 503: Service unavailable');
	});

	it('loads a paginated manifest and replays changes after its snapshot', async () => {
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>()
			.mockResolvedValueOnce(new Response(JSON.stringify({
				version: 1,
				files: { 'notes/a.md': { hash: 'a', size: 1, modified: 'one' } },
				lastSeq: 3,
				snapshotSeq: 3,
				hasMore: true,
				nextCursor: 'notes/a.md',
			})))
			.mockResolvedValueOnce(new Response(JSON.stringify({
				version: 1,
				files: { 'notes/b.md': { hash: 'b', size: 2, modified: 'two' } },
				lastSeq: 4,
				snapshotSeq: 3,
				hasMore: false,
			})))
			.mockResolvedValueOnce(new Response(JSON.stringify({
				changes: [
					{ seq: 4, path: 'notes/a.md', action: 'delete', hash: '', size: 0, created_at: 'four' },
					{ seq: 5, path: 'notes/c.md', action: 'put', hash: 'c', size: 3, created_at: 'five' },
				],
				lastSeq: 5,
				hasMore: false,
			})));
		vi.stubGlobal('fetch', fetchMock);
		const client = new SyncApiClient('https://worker.example', 'token');

		await expect(client.getManifest()).resolves.toEqual({
			version: 1,
			files: {
				'notes/b.md': { hash: 'b', size: 2, modified: 'two' },
				'notes/c.md': { hash: 'c', size: 3, modified: 'five' },
			},
			lastSeq: 5,
		});
		expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
			'https://worker.example/sync/manifest?limit=2000',
			'https://worker.example/sync/manifest?limit=2000&after=notes%2Fa.md&snapshotSeq=3',
			'https://worker.example/sync/changes?since=3',
		]);
	});

	it('updates credentials used by subsequent requests', async () => {
		const fetchMock = mockFetch(new Response('{"status":"ok","timestamp":"now"}'));
		const client = new SyncApiClient('https://old.example/', 'old-token');
		client.updateCredentials('https://new.example/', 'new-token');
		await client.health();

		const [url, requestValue] = fetchMock.mock.calls[0]!;
		const request = requestValue as RequestInit;
		expect(url).toBe('https://new.example/health');
		expect((request.headers as Record<string, string>).Authorization).toBe('Bearer new-token');
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
		const fetchMock = vi.fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>()
			.mockResolvedValueOnce(new Response(JSON.stringify({ settings, settingsVersion: 'version-1' })))
			.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Shared settings changed on another device' }), { status: 409 }))
			.mockResolvedValueOnce(new Response(JSON.stringify({ settings, settingsVersion: 'version-2' })))
			.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, settingsVersion: 'version-3' })));
		vi.stubGlobal('fetch', fetchMock);
		const client = new SyncApiClient('https://worker.example', 'token');

		await expect(client.putSharedSettings(settings)).rejects.toMatchObject({ status: 409 });
		await expect(client.putSharedSettings(settings)).resolves.toMatchObject({ settingsVersion: 'version-3' });

		expect(fetchMock.mock.calls.map(call => call[0])).toEqual([
			'https://worker.example/settings',
			'https://worker.example/settings',
			'https://worker.example/settings',
			'https://worker.example/settings',
		]);
		const lastPut = fetchMock.mock.calls[3]?.[1];
		if (typeof lastPut?.body !== 'string') throw new Error('Expected a JSON request body');
		expect(JSON.parse(lastPut.body) as unknown).toMatchObject({ expectedVersion: 'version-2' });
	});

	it('rejects in-flight requests with an AbortError when the sync signal aborts', async () => {
		vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
			}),
		));
		const controller = new AbortController();
		const client = new SyncApiClient('https://worker.example', 'token');
		client.setAbortSignal(controller.signal);

		const request = client.health();
		controller.abort();

		await expect(request).rejects.toMatchObject({
			name: 'AbortError',
			message: 'Sync request aborted',
		});
	});

	it('returns user-friendly testConnection failure details', async () => {
		mockFetch(new Response('boom', { status: 500 }));
		const client = new SyncApiClient('https://worker.example', 'token');
		await expect(client.testConnection()).resolves.toEqual({
			success: false,
			error: 'HTTP 500: boom',
		});
	});

	it('rejects a server with an incompatible protocol before the health check', async () => {
		const fetchMock = mockFetch(new Response(JSON.stringify({
			service: 'crate',
			serverVersion: '9.0.0',
			protocol: { current: 9, oldestCompatible: 9 },
			capabilities: ['sync-v1'],
		})));
		const client = new SyncApiClient('https://worker.example', 'token');
		await expect(client.testConnection()).resolves.toEqual({
			success: false,
			error: 'Incompatible Crate server protocol 9',
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('rejects insecure non-local worker URLs', () => {
		const client = new SyncApiClient('http://worker.example', 'token');
		expect(client.isConfigured()).toBe(false);
	});

	it('throws HttpError with retryAfter on 429 with Retry-After header', async () => {
		mockFetch(new Response('{"error":"Too many requests"}', {
			status: 429,
			headers: { 'Retry-After': '30' },
		}));
		const client = new SyncApiClient('https://worker.example', 'token');
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
		mockFetch(new Response('{"error":"Too many requests"}', {
			status: 429,
			headers: { 'Retry-After': 'Thu, 01 Jan 2026 00:00:30 GMT' },
		}));
		const client = new SyncApiClient('https://worker.example', 'token');
		try {
			await client.health();
			expect.unreachable('Should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(HttpError);
			expect((error as HttpError).retryAfter).toBe(30_000);
		}
	});

	it('throws HttpError with null retryAfter when no Retry-After header', async () => {
		mockFetch(new Response('{"error":"Server error"}', { status: 500 }));
		const client = new SyncApiClient('https://worker.example', 'token');
		try {
			await client.health();
			expect.unreachable('Should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(HttpError);
			expect(error).toMatchObject({ status: 500, retryAfter: null });
		}
	});
});
