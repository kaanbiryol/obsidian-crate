import { describe, expect, it, vi } from 'vitest';
import {
	handleDelete,
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
		const { db } = createMockD1Database();

		const response = await handleUpload(
			new Request('https://worker.test/sync/upload?path=notes/../secret.md', {
				method: 'PUT',
				body: 'hello',
			}),
			bucket,
			db,
		);

		expect(response.status).toBe(400);
		expect(await responseJson(response)).toEqual({ error: 'Invalid path' });
		expect(bucket.put).not.toHaveBeenCalled();
	});

	it('rejects uploads when the declared hash does not match the body', async () => {
		const { bucket } = createMockR2Bucket();
		const { db } = createMockD1Database();

		const response = await handleUpload(
			new Request('https://worker.test/sync/upload?path=notes/test.md', {
				method: 'PUT',
				body: 'hello',
				headers: {
					'X-File-Hash': '0'.repeat(64),
					'X-File-Size': '5',
					'X-Crate-Expected-Hash': 'absent',
				},
			}),
			bucket,
			db,
		);

		expect(response.status).toBe(400);
		expect(await responseJson(response)).toEqual({ error: 'File hash does not match X-File-Hash header' });
		expect(bucket.put).not.toHaveBeenCalled();
	});

	it('computes and stores upload hash metadata when the client does not send one', async () => {
		const { bucket, store } = createMockR2Bucket();
		const { db, files } = createMockD1Database();

		const response = await handleUpload(
			new Request('https://worker.test/sync/upload?path=notes/test.md', {
				method: 'PUT',
				body: 'hello',
				headers: {
					'Content-Type': 'text/plain',
					'X-Crate-Expected-Hash': 'absent',
				},
			}),
			bucket,
			db,
		);

		expect(response.status).toBe(200);
		const expectedHash = await sha256Hex('hello');
		expect(await responseJson(response)).toEqual({
			success: true,
			path: 'notes/test.md',
			hash: expectedHash,
      revision: files.get('notes/test.md')?.storageKey,
		});
		expect(files.get('notes/test.md')?.hash).toBe(expectedHash);
		expect(Array.from(store.values()).some(object => object.customMetadata?.hash === expectedHash)).toBe(true);
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
					'X-Crate-Expected-Hash': 'a'.repeat(64),
				},
			}),
			bucket,
			db,
		);

		expect(response.status).toBe(503);
		expect(await responseJson(response)).toEqual({
			success: false,
			path: 'notes/test.md',
			error: 'Upload outcome is unknown because the metadata response failed; reconcile before retrying: D1 unavailable',
		});
		expect(new TextDecoder().decode(store.get('files/notes/test.md')?.body)).toBe('before');
	});

	it('leaves staged bytes untouched after an uncertain commit even when cleanup is unavailable', async () => {
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
					'X-Crate-Expected-Hash': 'absent',
				},
			}),
			bucket,
			db,
		);

		expect(response.status).toBe(503);
		expect(await responseJson(response)).toEqual({
			success: false,
			path: 'notes/test.md',
			error: 'Upload outcome is unknown because the metadata response failed; reconcile before retrying: D1 unavailable',
		});
		expect(bucket.delete).not.toHaveBeenCalled();
	});

	it('returns 400 for invalid JSON delete requests instead of throwing 500', async () => {
		const { bucket } = createMockR2Bucket();
		const { db } = createMockD1Database();

		const response = await handleDelete(
			new Request('https://worker.test/sync/delete', {
				method: 'POST',
				body: '{invalid',
				headers: { 'Content-Type': 'application/json' },
			}),
			bucket,
			db,
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
				body: JSON.stringify({ path: 'notes/test.md', expectedHash: 'a'.repeat(64), expectedRevision: 'files/notes/test.md' }),
				headers: { 'Content-Type': 'application/json' },
			}),
			bucket,
			db,
		);

		expect(response.status).toBe(503);
		expect(await responseJson(response)).toEqual({
			success: false,
			path: 'notes/test.md',
			error: 'Delete outcome is unknown because the metadata response failed; reconcile before retrying: D1 unavailable',
		});
		expect(new TextDecoder().decode(store.get('files/notes/test.md')?.body)).toBe('before');
	});

	it('retains deleted content instead of racing another delete cleanup', async () => {
		const managedKey = '__crate__/files/hash/object-to-delete';
		const { bucket, store } = createMockR2Bucket({
			[managedKey]: 'before',
		});
		const { db, files } = createMockD1Database({
			files: {
				'notes/test.md': { hash: 'a'.repeat(64), size: 6, storageKey: managedKey },
			},
		});

		const response = await handleDelete(
			new Request('https://worker.test/sync/delete', {
				method: 'POST',
				body: JSON.stringify({ path: 'notes/test.md', expectedHash: 'a'.repeat(64), expectedRevision: managedKey }),
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
		expect(new TextDecoder().decode(store.get(managedKey)?.body)).toBe('before');
		expect(bucket.delete).not.toHaveBeenCalled();
	});
});
