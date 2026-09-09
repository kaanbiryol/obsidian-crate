import { describe, expect, it } from 'vitest';
import {
	handleBatchDownload,
	handleBatchDelete,
	handleBatchUpload,
	handleDownload,
	handleGetSettings,
	handlePutSettings,
} from './sync-handlers';
import { createMockD1Database, createMockR2Bucket, createTestUploadOperationId } from '@/test/factories/cloudflare';

async function responseJson(response: Response): Promise<unknown> {
	return response.json() as Promise<unknown>;
}

describe('worker sync handlers', () => {
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
							operationId: createTestUploadOperationId(), expectedHash: 'a'.repeat(64), expectedRevision: 'files/notes/test.md',
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
					error: 'Upload outcome is unknown because the metadata response failed; reconcile before retrying: D1 unavailable',
					code: 'storage',
					status: 503,
				},
			],
		});
		expect(new TextDecoder().decode(store.get('files/notes/test.md')?.body)).toBe('before');
	});

	it('leaves batch deletes uncommitted when the D1 metadata write fails', async () => {
		const { bucket, store } = createMockR2Bucket({
			'files/notes/test.md': 'before',
		});
		const { db } = createMockD1Database({ failBatch: true,
			files: { 'notes/test.md': { hash: 'a'.repeat(64), size: 6, storageKey: 'files/notes/test.md' } },
		});

		const response = await handleBatchDelete(
			new Request('https://worker.test/sync/batch-delete', {
				method: 'POST',
				body: JSON.stringify({
					files: [{ path: 'notes/test.md', operationId: createTestUploadOperationId(), expectedHash: 'a'.repeat(64), expectedRevision: 'files/notes/test.md' }],
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
					error: 'Delete outcome is unknown because the metadata response failed; reconcile before retrying: D1 unavailable',
					code: 'storage',
					status: 503,
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

	it('batch downloads committed files through their D1 storage keys', async () => {
		const managedKey = '__crate__/files/hash/batch-object';
		const { bucket } = createMockR2Bucket({
			[managedKey]: 'hello',
		});
		const { db } = createMockD1Database({
			files: {
				'notes/test.md': managedKey,
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
          revision: managedKey,
					hash: '',
					size: 5,
					contentType: 'application/octet-stream',
				},
			],
		});
		expect(bucket.get).toHaveBeenCalledWith(managedKey);
	});

	it('validates shared settings writes and treats corrupt stored settings as absent', async () => {
		const { bucket } = createMockR2Bucket({
			'__crate__/settings.json': '{broken json',
		});

		const getResponse = await handleGetSettings(bucket);
		expect(getResponse.status).toBe(200);
		expect(await responseJson(getResponse)).toEqual({
			settings: null,
			settingsVersion: 'initial-__crate__/settings.json',
		});

		await bucket.put(
			'__crate__/settings.json',
			new TextEncoder().encode(JSON.stringify({
				ignorePatterns: ['.git/'],
				syncOnStartup: true,
				syncInterval: 30,
				showStatusBar: true,
			})).buffer,
		);
		const incompleteGetResponse = await handleGetSettings(bucket);
		expect(await responseJson(incompleteGetResponse)).toEqual({
			settings: null,
			settingsVersion: 'etag-1',
		});
		const currentVersion = (await bucket.head('__crate__/settings.json'))?.etag ?? null;

		const badPutResponse = await handlePutSettings(
			new Request('https://worker.test/settings', {
				method: 'PUT',
				body: JSON.stringify({
					expectedVersion: currentVersion,
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
					expectedVersion: currentVersion,
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

	it('rejects a stale shared-settings write instead of losing a concurrent edit', async () => {
		const { bucket } = createMockR2Bucket();
		const firstSettings = {
			ignorePatterns: ['first'],
			syncOnStartup: true,
			syncOnResume: true,
			syncInterval: 30,
			showStatusBar: true,
			pushEnabled: false,
		};
		const firstWrite = await bucket.put('__crate__/settings.json', JSON.stringify(firstSettings));
		if (!firstWrite) throw new Error('Expected settings fixture write');
		await bucket.put('__crate__/settings.json', JSON.stringify({ ...firstSettings, ignorePatterns: ['concurrent'] }));

		const response = await handlePutSettings(new Request('https://worker.test/settings', {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ expectedVersion: firstWrite.etag, settings: firstSettings }),
		}), bucket);

		expect(response.status).toBe(409);
		expect(await bucket.get('__crate__/settings.json').then(object => object?.text()))
			.toContain('concurrent');
	});

	it('rejects malformed batch upload entries without writing them', async () => {
		const { bucket } = createMockR2Bucket();
		const { db } = createMockD1Database();

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
			db,
		);

		expect(response.status).toBe(200);
		expect(await responseJson(response)).toEqual({
			success: false,
			results: [
				{
					path: 'notes/test.md',
					success: false,
					error: 'Invalid file payload',
					code: 'validation',
					status: 400,
				},
			],
		});
		expect(bucket.put).not.toHaveBeenCalled();
	});
});
