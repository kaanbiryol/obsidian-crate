import { afterEach, describe, expect, it, vi } from 'vitest';
import * as obsidian from 'obsidian';
import type { RequestUrlResponse } from 'obsidian';
import { HttpError, SyncApiClient } from './api';

function createRequestUrlResponse(overrides: Partial<RequestUrlResponse>): RequestUrlResponse {
	return {
		status: 200,
		headers: {},
		arrayBuffer: new ArrayBuffer(0),
		json: {},
		text: '',
		...overrides,
	};
}

describe('SyncApiClient', () => {
	afterEach(() => {
		vi.resetAllMocks();
	});

	it('uses encoded paths and auth headers for requests', async () => {
		const requestUrlSpy = vi.spyOn(obsidian, 'requestUrl').mockResolvedValue(
			createRequestUrlResponse({
				status: 200,
				arrayBuffer: new ArrayBuffer(1),
				headers: {
					'Content-Type': 'text/plain',
					'Content-Length': '1',
				},
			}),
		);
		const body = new ArrayBuffer(1);

		const client = new SyncApiClient('https://worker.example/', 'token-1');
		await expect(client.downloadFile('folder/a b#.md')).resolves.toEqual({
			content: body,
			contentType: 'text/plain',
			size: 1,
		});

		const request = requestUrlSpy.mock.calls[0]?.[0];
		if (!request || typeof request === 'string') {
			throw new Error('Expected requestUrl to be called with a request object');
		}
		expect(request.url).toBe('https://worker.example/sync/download?path=folder%2Fa%20b%23.md');
		expect(request.method).toBeUndefined();
		expect(request.headers?.Authorization).toBe('Bearer token-1');
	});

	it('parses JSON error responses', async () => {
		vi.spyOn(obsidian, 'requestUrl').mockResolvedValue(
			createRequestUrlResponse({
				status: 401,
				text: '{"error":"Unauthorized"}',
			}),
		);

		const client = new SyncApiClient('https://worker.example', 'token');
		await expect(client.health()).rejects.toThrow('Unauthorized');
	});

	it('falls back to HTTP status and body for non-JSON errors', async () => {
		vi.spyOn(obsidian, 'requestUrl').mockResolvedValue(
			createRequestUrlResponse({
				status: 503,
				text: 'Service unavailable',
			}),
		);

		const client = new SyncApiClient('https://worker.example', 'token');
		await expect(client.getManifest()).rejects.toThrow(
			'HTTP 503: Service unavailable',
		);
	});

	it('updates credentials used by subsequent requests', async () => {
		const requestUrlSpy = vi.spyOn(obsidian, 'requestUrl').mockResolvedValue(
			createRequestUrlResponse({
				status: 200,
				text: '{"status":"ok","timestamp":"now"}',
			}),
		);

		const client = new SyncApiClient('https://old.example/', 'old-token');
		client.updateCredentials('https://new.example/', 'new-token');
		await client.health();

		const request = requestUrlSpy.mock.calls[0]?.[0];
		if (!request || typeof request === 'string') {
			throw new Error('Expected requestUrl to be called with a request object');
		}
		expect(request.url).toBe('https://new.example/health');
		expect(request.headers?.Authorization).toBe('Bearer new-token');
	});

	it('returns user-friendly testConnection failure details', async () => {
		vi.spyOn(obsidian, 'requestUrl').mockResolvedValue(
			createRequestUrlResponse({
				status: 500,
				text: 'boom',
			}),
		);

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
		vi.spyOn(obsidian, 'requestUrl').mockResolvedValue(
			createRequestUrlResponse({
				status: 429,
				headers: { 'Retry-After': '30' },
				text: '{"error":"Too many requests"}',
			}),
		);

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
		vi.spyOn(obsidian, 'requestUrl').mockResolvedValue(
			createRequestUrlResponse({
				status: 500,
				text: '{"error":"Server error"}',
			}),
		);

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
