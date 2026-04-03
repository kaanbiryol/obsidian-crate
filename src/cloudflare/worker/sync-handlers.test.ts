import { describe, expect, it, vi } from 'vitest';
import {
	handleBatchDelete,
	handleBatchUpload,
	handleDelete,
	handleGetSettings,
	handlePutSettings,
	handleUpload,
} from './sync-handlers';

type StoredObject = {
	body: ArrayBuffer;
	httpMetadata?: { contentType?: string };
	customMetadata?: { hash?: string };
};

function createBucket(initialEntries: Record<string, string> = {}) {
	const store = new Map<string, StoredObject>();
	for (const [key, value] of Object.entries(initialEntries)) {
		store.set(key, {
			body: new TextEncoder().encode(value).buffer,
		});
	}

	return {
		store,
		bucket: {
			put: vi.fn(async (key: string, body: ArrayBuffer, options?: StoredObject) => {
				store.set(key, {
					body,
					httpMetadata: options?.httpMetadata,
					customMetadata: options?.customMetadata,
				});
			}),
			get: vi.fn(async (key: string) => {
				const entry = store.get(key);
				if (!entry) {
					return null;
				}

				return {
					body: entry.body,
					size: entry.body.byteLength,
					httpMetadata: entry.httpMetadata,
					customMetadata: entry.customMetadata,
					arrayBuffer: async () => entry.body,
					text: async () => new TextDecoder().decode(entry.body),
				};
			}),
			delete: vi.fn(async (key: string) => {
				store.delete(key);
			}),
		},
	};
}

function createDb(options?: { failBatch?: boolean }) {
	const db = {
		prepare: vi.fn((sql: string) => {
			const statement = {
				bind: vi.fn(() => statement),
				run: vi.fn(async () => {
					if (sql.startsWith('CREATE TABLE')) {
						return {};
					}
					return {};
				}),
				first: vi.fn(async () => null),
				all: vi.fn(async () => ({ results: [] })),
			};
			return statement;
		}),
		batch: vi.fn(async () => {
			if (options?.failBatch) {
				throw new Error('D1 unavailable');
			}
			return [];
		}),
		exec: vi.fn(async () => ({})),
	};

	return { db };
}

async function responseJson(response: Response): Promise<unknown> {
	return response.json() as Promise<unknown>;
}

async function sha256Hex(data: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

describe('worker sync handlers', () => {
	it('rejects traversal-style upload paths', async () => {
		const { bucket } = createBucket();

		const response = await handleUpload(
			new Request('https://worker.test/sync/upload?path=notes/../secret.md', {
				method: 'PUT',
				body: 'hello',
			}),
			bucket as never,
			null,
		);

		expect(response.status).toBe(400);
		expect(await responseJson(response)).toEqual({ error: 'Invalid path' });
		expect(bucket.put).not.toHaveBeenCalled();
	});

	it('rejects uploads when the declared hash does not match the body', async () => {
		const { bucket } = createBucket();

		const response = await handleUpload(
			new Request('https://worker.test/sync/upload?path=notes/test.md', {
				method: 'PUT',
				body: 'hello',
				headers: {
					'X-File-Hash': '0'.repeat(64),
					'X-File-Size': '5',
				},
			}),
			bucket as never,
			null,
		);

		expect(response.status).toBe(400);
		expect(await responseJson(response)).toEqual({ error: 'File hash does not match X-File-Hash header' });
		expect(bucket.put).not.toHaveBeenCalled();
	});

	it('computes and stores upload hash metadata when the client does not send one', async () => {
		const { bucket, store } = createBucket();

		const response = await handleUpload(
			new Request('https://worker.test/sync/upload?path=notes/test.md', {
				method: 'PUT',
				body: 'hello',
				headers: {
					'Content-Type': 'text/plain',
				},
			}),
			bucket as never,
			null,
		);

		expect(response.status).toBe(200);
		const expectedHash = await sha256Hex('hello');
		expect(await responseJson(response)).toEqual({
			success: true,
			path: 'notes/test.md',
			hash: expectedHash,
		});
		expect(store.get('files/notes/test.md')?.customMetadata?.hash).toBe(expectedHash);
	});

	it('rolls back single-file uploads when the D1 metadata write fails', async () => {
		const { bucket, store } = createBucket({
			'files/notes/test.md': 'before',
		});
		const { db } = createDb({ failBatch: true });

		const response = await handleUpload(
			new Request('https://worker.test/sync/upload?path=notes/test.md', {
				method: 'PUT',
				body: 'after',
				headers: {
					'Content-Type': 'text/plain',
				},
			}),
			bucket as never,
			db as never,
		);

		expect(response.status).toBe(503);
		expect(await responseJson(response)).toEqual({
			success: false,
			path: 'notes/test.md',
			error: 'Upload rolled back because sync metadata update failed: D1 unavailable',
		});
		expect(new TextDecoder().decode(store.get('files/notes/test.md')?.body)).toBe('before');
	});

	it('returns 400 for invalid JSON delete requests instead of throwing 500', async () => {
		const { bucket } = createBucket();

		const response = await handleDelete(
			new Request('https://worker.test/sync/delete', {
				method: 'POST',
				body: '{invalid',
				headers: { 'Content-Type': 'application/json' },
			}),
			bucket as never,
			null,
		);

		expect(response.status).toBe(400);
		expect(await responseJson(response)).toEqual({ error: 'Invalid JSON body' });
	});

	it('rolls back single-file deletes when the D1 metadata write fails', async () => {
		const { bucket, store } = createBucket({
			'files/notes/test.md': 'before',
		});
		const { db } = createDb({ failBatch: true });

		const response = await handleDelete(
			new Request('https://worker.test/sync/delete', {
				method: 'POST',
				body: JSON.stringify({ path: 'notes/test.md' }),
				headers: { 'Content-Type': 'application/json' },
			}),
			bucket as never,
			db as never,
		);

		expect(response.status).toBe(503);
		expect(await responseJson(response)).toEqual({
			success: false,
			path: 'notes/test.md',
			error: 'Delete rolled back because sync metadata update failed: D1 unavailable',
		});
		expect(new TextDecoder().decode(store.get('files/notes/test.md')?.body)).toBe('before');
	});

	it('reports partial batch delete failures instead of claiming full success', async () => {
		const { bucket } = createBucket();
		bucket.delete = vi.fn(async (key: string) => {
			if (key === 'files/notes/fail.md') {
				throw new Error('bucket unavailable');
			}
		});

		const response = await handleBatchDelete(
			new Request('https://worker.test/sync/batch-delete', {
				method: 'POST',
				body: JSON.stringify({
					paths: ['notes/ok.md', 'notes/fail.md'],
				}),
				headers: { 'Content-Type': 'application/json' },
			}),
			bucket as never,
			null,
		);

		expect(response.status).toBe(200);
		expect(await responseJson(response)).toEqual({
			success: false,
			deleted: ['notes/ok.md'],
			errors: [
				{
					path: 'notes/fail.md',
					error: 'bucket unavailable',
				},
			],
		});
	});

	it('validates shared settings writes and treats corrupt stored settings as absent', async () => {
		const { bucket } = createBucket({
			'__crate__/settings.json': '{broken json',
		});

		const getResponse = await handleGetSettings(bucket as never);
		expect(getResponse.status).toBe(200);
		expect(await responseJson(getResponse)).toEqual({ settings: null });

		await bucket.put(
			'__crate__/settings.json',
			new TextEncoder().encode(JSON.stringify({
				ignorePatterns: ['.git/'],
				syncOnStartup: true,
				syncInterval: 30,
				showStatusBar: true,
			})).buffer,
		);
		const legacyGetResponse = await handleGetSettings(bucket as never);
		expect(await responseJson(legacyGetResponse)).toEqual({
			settings: {
				ignorePatterns: ['.git/'],
				syncOnStartup: true,
				syncInterval: 30,
				showStatusBar: true,
				pushEnabled: false,
			},
		});

		const badPutResponse = await handlePutSettings(
			new Request('https://worker.test/settings', {
				method: 'PUT',
				body: JSON.stringify({
					settings: {
						ignorePatterns: ['ok'],
						syncOnStartup: 'yes',
						syncInterval: 30,
						showStatusBar: true,
						pushEnabled: false,
					},
				}),
				headers: { 'Content-Type': 'application/json' },
			}),
			bucket as never,
		);
		expect(badPutResponse.status).toBe(400);

		const goodPutResponse = await handlePutSettings(
			new Request('https://worker.test/settings', {
				method: 'PUT',
				body: JSON.stringify({
					settings: {
						ignorePatterns: ['.git/'],
						syncOnStartup: true,
						syncInterval: 30,
						showStatusBar: true,
						pushEnabled: false,
					},
				}),
				headers: { 'Content-Type': 'application/json' },
			}),
			bucket as never,
		);
		expect(goodPutResponse.status).toBe(200);
	});

	it('rejects malformed batch upload entries without writing them', async () => {
		const { bucket } = createBucket();

		const response = await handleBatchUpload(
			new Request('https://worker.test/sync/batch-upload', {
				method: 'POST',
				body: JSON.stringify({
					files: [
						{
							path: 'notes/test.md',
							content: 123,
						},
					],
				}),
				headers: { 'Content-Type': 'application/json' },
			}),
			bucket as never,
			null,
		);

		expect(response.status).toBe(200);
		expect(await responseJson(response)).toEqual({
			success: false,
			results: [
				{
					path: 'notes/test.md',
					success: false,
					error: 'Invalid file payload',
				},
			],
		});
		expect(bucket.put).not.toHaveBeenCalled();
	});
});
