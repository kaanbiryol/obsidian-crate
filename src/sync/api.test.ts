import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, SyncApiClient } from './api';

describe('SyncApiClient', () => {
	beforeEach(() => {
		vi.stubGlobal('fetch', vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.resetAllMocks();
	});

	it('uses encoded paths and auth headers for requests', async () => {
		const fetchMock = vi.mocked(fetch);
		const body = new ArrayBuffer(1);
		const headers = new Headers({
			'Content-Type': 'text/plain',
			'Content-Length': '1',
		});
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			arrayBuffer: vi.fn().mockResolvedValue(body),
			headers,
		} as unknown as Response);

		const client = new SyncApiClient('https://worker.example/', 'token-1');
		await client.downloadFile('folder/a b#.md');

		expect(fetchMock).toHaveBeenCalledWith(
			'https://worker.example/sync/download?path=folder%2Fa%20b%23.md',
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: 'Bearer token-1',
				}),
			}),
		);
	});

	it('parses JSON error responses', async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValue({
			ok: false,
			status: 401,
			headers: new Headers(),
			text: vi.fn().mockResolvedValue('{"error":"Unauthorized"}'),
		} as unknown as Response);

		const client = new SyncApiClient('https://worker.example', 'token');
		await expect(client.health()).rejects.toThrow('Unauthorized');
	});

	it('falls back to HTTP status and body for non-JSON errors', async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValue({
			ok: false,
			status: 503,
			headers: new Headers(),
			text: vi.fn().mockResolvedValue('Service unavailable'),
		} as unknown as Response);

		const client = new SyncApiClient('https://worker.example', 'token');
		await expect(client.getManifest()).rejects.toThrow(
			'HTTP 503: Service unavailable',
		);
	});

	it('updates credentials used by subsequent requests', async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValue({
			ok: true,
			status: 200,
			json: vi.fn().mockResolvedValue({ status: 'ok', timestamp: 'now' }),
		} as unknown as Response);

		const client = new SyncApiClient('https://old.example/', 'old-token');
		client.updateCredentials('https://new.example/', 'new-token');
		await client.health();

		expect(fetchMock).toHaveBeenCalledWith(
			'https://new.example/health',
			expect.objectContaining({
				headers: expect.objectContaining({
					Authorization: 'Bearer new-token',
				}),
			}),
		);
	});

	it('returns user-friendly testConnection failure details', async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValue({
			ok: false,
			status: 500,
			headers: new Headers(),
			text: vi.fn().mockResolvedValue('boom'),
		} as unknown as Response);

		const client = new SyncApiClient('https://worker.example', 'token');
		await expect(client.testConnection()).resolves.toEqual({
			success: false,
			error: 'HTTP 500: boom',
		});
	});

	it('rejects insecure non-local worker URLs', () => {
		const client = new SyncApiClient('http://worker.example', 'token');
		expect(client.isConfigured()).toBe(false);
	});

	it('throws HttpError with retryAfter on 429 with Retry-After header', async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValue({
			ok: false,
			status: 429,
			headers: new Headers({ 'Retry-After': '30' }),
			text: vi.fn().mockResolvedValue('{"error":"Too many requests"}'),
		} as unknown as Response);

		const client = new SyncApiClient('https://worker.example', 'token');
		try {
			await client.health();
			expect.unreachable('Should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(HttpError);
			const httpError = error as HttpError;
			expect(httpError.status).toBe(429);
			expect(httpError.retryAfter).toBe(30_000);
			expect(httpError.message).toBe('Too many requests');
		}
	});

	it('throws HttpError with null retryAfter when no Retry-After header', async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockResolvedValue({
			ok: false,
			status: 500,
			headers: new Headers(),
			text: vi.fn().mockResolvedValue('{"error":"Server error"}'),
		} as unknown as Response);

		const client = new SyncApiClient('https://worker.example', 'token');
		try {
			await client.health();
			expect.unreachable('Should have thrown');
		} catch (error) {
			expect(error).toBeInstanceOf(HttpError);
			const httpError = error as HttpError;
			expect(httpError.status).toBe(500);
			expect(httpError.retryAfter).toBeNull();
		}
	});
});
