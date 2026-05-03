import { describe, expect, it, vi } from 'vitest';
import {
	handleBatchDownload,
	handleBatchDelete,
	handleBatchUpload,
	handleDelete,
	handleDownload,
	handleGetSettings,
	handlePutSettings,
	handleUpload,
} from './sync-handlers';
import { createMockD1Database, createMockR2Bucket } from '@/test/factories/cloudflare';

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
		const { bucket } = createMockR2Bucket();

		const response = await handleUpload(
			new Request('https://worker.test/sync/upload?path=notes/../secret.md', {
				method: 'PUT',
				body: 'hello',
			}),
			bucket,
			null,
		);

		expect(response.status).toBe(400);
		expect(await responseJson(response)).toEqual({ error: 'Invalid path' });
		expect(bucket.put).not.toHaveBeenCalled();
	});

	it('rejects uploads when the declared hash does not match the body', async () => {
		const { bucket } = createMockR2Bucket();

		const response = await handleUpload(
			new Request('https://worker.test/sync/upload?path=notes/test.md', {
				method: 'PUT',
				body: 'hello',
				headers: {
					'X-File-Hash': '0'.repeat(64),
					'X-File-Size': '5',
				},
			}),
			bucket,
			null,
		);

		expect(response.status).toBe(400);
		expect(await responseJson(response)).toEqual({ error: 'File hash does not match X-File-Hash header' });
		expect(bucket.put).not.toHaveBeenCalled();
	});

	it('computes and stores upload hash metadata when the client does not send one', async () => {
		const { bucket, store } = createMockR2Bucket();

		const response = await handleUpload(
			new Request('https://worker.test/sync/upload?path=notes/test.md', {
				method: 'PUT',
				body: 'hello',
				headers: {
					'Content-Type': 'text/plain',
				},
			}),
			bucket,
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

	it('leaves single-file uploads uncommitted when the D1 metadata write fails', async () => {
		const { bucket, store } = createMockR2Bucket({
			'files/notes/test.md': 'before',
		});
		const { db } = createMockD1Database({ failBatch: true });

		const response = await handleUpload(
			new Request('https://worker.test/sync/upload?path=notes/test.md', {
				method: 'PUT',
				body: 'after',
				headers: {
					'Content-Type': 'text/plain',
				},
			}),
			bucket,
			db,
		);

		expect(response.status).toBe(503);
		expect(await responseJson(response)).toEqual({
			success: false,
			path: 'notes/test.md',
			error: 'Upload not committed because sync metadata update failed: D1 unavailable',
		});
		expect(new TextDecoder().decode(store.get('files/notes/test.md')?.body)).toBe('before');
	});

	it('still returns 503 when upload cleanup after a failed D1 commit also fails', async () => {
		const { bucket } = createMockR2Bucket();
		bucket.delete = vi.fn(async () => {
			throw new Error('cleanup unavailable');
		});
		const { db } = createMockD1Database({ failBatch: true });

		const response = await handleUpload(
			new Request('https://worker.test/sync/upload?path=notes/test.md', {
				method: 'PUT',
				body: 'after',
				headers: {
					'Content-Type': 'text/plain',
				},
			}),
			bucket,
			db,
		);

		expect(response.status).toBe(503);
		expect(await responseJson(response)).toEqual({
			success: false,
			path: 'notes/test.md',
			error: 'Upload not committed because sync metadata update failed: D1 unavailable',
		});
		expect(bucket.delete).toHaveBeenCalledTimes(1);
	});

	it('returns 400 for invalid JSON delete requests instead of throwing 500', async () => {
		const { bucket } = createMockR2Bucket();

		const response = await handleDelete(
			new Request('https://worker.test/sync/delete', {
				method: 'POST',
				body: '{invalid',
				headers: { 'Content-Type': 'application/json' },
			}),
			bucket,
			null,
		);

		expect(response.status).toBe(400);
		expect(await responseJson(response)).toEqual({ error: 'Invalid JSON body' });
	});

	it('leaves single-file deletes uncommitted when the D1 metadata write fails', async () => {
		const { bucket, store } = createMockR2Bucket({
			'files/notes/test.md': 'before',
		});
		const { db } = createMockD1Database({ failBatch: true });

		const response = await handleDelete(
			new Request('https://worker.test/sync/delete', {
				method: 'POST',
				body: JSON.stringify({ path: 'notes/test.md' }),
				headers: { 'Content-Type': 'application/json' },
			}),
			bucket,
			db,
		);

		expect(response.status).toBe(503);
		expect(await responseJson(response)).toEqual({
			success: false,
			path: 'notes/test.md',
			error: 'Delete not committed because sync metadata update failed: D1 unavailable',
		});
		expect(new TextDecoder().decode(store.get('files/notes/test.md')?.body)).toBe('before');
	});

	it('returns success when delete cleanup fails after the D1 commit', async () => {
		const { bucket, store } = createMockR2Bucket({
			'files/notes/test.md': 'before',
		});
		bucket.delete = vi.fn(async () => {
			throw new Error('cleanup unavailable');
		});
		const { db, files } = createMockD1Database({
			files: {
				'notes/test.md': null,
			},
		});

		const response = await handleDelete(
			new Request('https://worker.test/sync/delete', {
				method: 'POST',
				body: JSON.stringify({ path: 'notes/test.md' }),
				headers: { 'Content-Type': 'application/json' },
			}),
			bucket,
			db,
		);

		expect(response.status).toBe(200);
		expect(await responseJson(response)).toEqual({
			success: true,
			path: 'notes/test.md',
		});
		expect(files.has('notes/test.md')).toBe(false);
		expect(new TextDecoder().decode(store.get('files/notes/test.md')?.body)).toBe('before');
	});

	it('reports partial batch delete failures instead of claiming full success', async () => {
		const { bucket } = createMockR2Bucket();
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
			bucket,
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

	it('leaves batch uploads uncommitted when the D1 metadata write fails', async () => {
		const { bucket, store } = createMockR2Bucket({
			'files/notes/test.md': 'before',
		});
		const { db } = createMockD1Database({ failBatch: true });

		const response = await handleBatchUpload(
			new Request('https://worker.test/sync/batch-upload', {
				method: 'POST',
				body: JSON.stringify({
					files: [
						{
							path: 'notes/test.md',
							content: btoa('after'),
							size: 5,
							contentType: 'text/plain',
						},
					],
				}),
				headers: { 'Content-Type': 'application/json' },
			}),
			bucket,
			db,
		);

		expect(response.status).toBe(503);
		expect(await responseJson(response)).toEqual({
			success: false,
			results: [
				{
					path: 'notes/test.md',
					success: false,
					error: 'Upload not committed because sync metadata update failed: D1 unavailable',
				},
			],
		});
		expect(new TextDecoder().decode(store.get('files/notes/test.md')?.body)).toBe('before');
	});

	it('leaves batch deletes uncommitted when the D1 metadata write fails', async () => {
		const { bucket, store } = createMockR2Bucket({
			'files/notes/test.md': 'before',
		});
		const { db } = createMockD1Database({ failBatch: true });

		const response = await handleBatchDelete(
			new Request('https://worker.test/sync/batch-delete', {
				method: 'POST',
				body: JSON.stringify({
					paths: ['notes/test.md'],
				}),
				headers: { 'Content-Type': 'application/json' },
			}),
			bucket,
			db,
		);

		expect(response.status).toBe(503);
		expect(await responseJson(response)).toEqual({
			success: false,
			deleted: [],
			errors: [
				{
					path: 'notes/test.md',
					error: 'Delete not committed because sync metadata update failed: D1 unavailable',
				},
			],
		});
		expect(new TextDecoder().decode(store.get('files/notes/test.md')?.body)).toBe('before');
	});

	it('downloads committed files through their D1 storage keys', async () => {
		const managedKey = '__crate__/files/hash/object-1';
		const { bucket } = createMockR2Bucket({
			[managedKey]: 'hello',
		});
		const { db } = createMockD1Database({
			files: {
				'notes/test.md': managedKey,
			},
		});

		const response = await handleDownload(
			new Request('https://worker.test/sync/download?path=notes/test.md'),
			bucket,
			db,
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('hello');
		expect(bucket.get).toHaveBeenCalledWith(managedKey);
	});

	it('batch downloads legacy path-backed files when migrated rows have no storage key yet', async () => {
		const { bucket } = createMockR2Bucket({
			'files/notes/test.md': 'hello',
		});
		const { db } = createMockD1Database({
			files: {
				'notes/test.md': null,
			},
		});

		const response = await handleBatchDownload(
			new Request('https://worker.test/sync/batch-download', {
				method: 'POST',
				body: JSON.stringify({
					paths: ['notes/test.md'],
				}),
				headers: { 'Content-Type': 'application/json' },
			}),
			bucket,
			db,
		);

		expect(response.status).toBe(200);
		expect(await responseJson(response)).toEqual({
			files: [
				{
					path: 'notes/test.md',
					content: btoa('hello'),
					hash: '',
					size: 5,
					contentType: 'application/octet-stream',
				},
			],
		});
		expect(bucket.get).toHaveBeenCalledWith('files/notes/test.md');
	});

	it('validates shared settings writes and treats corrupt stored settings as absent', async () => {
		const { bucket } = createMockR2Bucket({
			'__crate__/settings.json': '{broken json',
		});

		const getResponse = await handleGetSettings(bucket);
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
		const legacyGetResponse = await handleGetSettings(bucket);
		expect(await responseJson(legacyGetResponse)).toEqual({
			settings: {
				ignorePatterns: ['.git/'],
				syncOnStartup: true,
				syncOnResume: true,
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
						syncOnResume: true,
						syncInterval: 30,
						showStatusBar: true,
						pushEnabled: false,
					},
				}),
				headers: { 'Content-Type': 'application/json' },
			}),
			bucket,
		);
		expect(badPutResponse.status).toBe(400);

		const goodPutResponse = await handlePutSettings(
			new Request('https://worker.test/settings', {
				method: 'PUT',
				body: JSON.stringify({
					settings: {
						ignorePatterns: ['.git/'],
						syncOnStartup: true,
						syncOnResume: true,
						syncInterval: 30,
						showStatusBar: true,
						pushEnabled: false,
					},
				}),
				headers: { 'Content-Type': 'application/json' },
			}),
			bucket,
		);
		expect(goodPutResponse.status).toBe(200);
	});

	it('rejects malformed batch upload entries without writing them', async () => {
		const { bucket } = createMockR2Bucket();

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
			bucket,
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
