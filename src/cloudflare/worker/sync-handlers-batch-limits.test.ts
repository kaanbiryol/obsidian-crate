import { commitStagedFile } from './sync-mutations';
import { describe, expect, it } from 'vitest';
import {
	handleBatchDownload,
	handleBatchDelete,
	handleBatchUpload,
	handleDelete,
	handleUpload,
} from './sync-handlers';
import { createMockD1Database, createMockR2Bucket, createTestUploadOperationId } from '@/test/factories/cloudflare';

async function responseJson(response: Response): Promise<unknown> {
	return response.json() as Promise<unknown>;
}

describe('worker sync handlers', () => {
it('loads metadata for a maximum download batch with one D1 query', async () => {
		const paths = Array.from({ length: 50 }, (_, index) => `notes/${index}.md`);
		const { bucket } = createMockR2Bucket();
		const { db } = createMockD1Database({
			files: Object.fromEntries(paths.map((path, index) => [path, {
				hash: String(index).padStart(64, '0'),
				size: 1,
				storageKey: `object-${index}`,
			}])),
		});

		const response = await handleBatchDownload(
			new Request('https://worker.test/sync/batch-download', {
				method: 'POST',
				body: JSON.stringify({ paths }),
				headers: { 'Content-Type': 'application/json' },
			}),
			bucket,
			db,
		);

		expect(response.status).toBe(200);
		const metadataQueries = db.prepare.mock.calls.filter(([sql]) =>
			typeof sql === 'string' && sql.includes('FROM files WHERE path IN'));
		expect(metadataQueries).toHaveLength(1);
		expect(metadataQueries[0]?.[0]).toContain(Array.from({ length: 50 }, () => '?').join(', '));
	});

	it('rejects mutation batches above the Free-plan-safe limit', async () => {
		const files = Array.from({ length: 7 }, (_, index) => ({
			path: `notes/${index}.md`,
			content: btoa('x'),
			operationId: createTestUploadOperationId(), expectedHash: null,
		}));
		const { bucket } = createMockR2Bucket();
		const { db } = createMockD1Database();

		const uploadResponse = await handleBatchUpload(
			new Request('https://worker.test/sync/batch-upload', {
				method: 'POST',
				body: JSON.stringify({ files }),
			}),
			bucket,
			db,
		);
		const deleteResponse = await handleBatchDelete(
			new Request('https://worker.test/sync/batch-delete', {
				method: 'POST',
				body: JSON.stringify({
					files: files.map((file) => ({ path: file.path, operationId: createTestUploadOperationId(), expectedHash: 'a'.repeat(64) })),
				}),
			}),
			bucket,
			db,
		);

		expect(uploadResponse.status).toBe(400);
		expect(deleteResponse.status).toBe(400);
		expect(bucket.put).not.toHaveBeenCalled();
	});

	it('keeps a worst-case stale upload batch within the Free-plan D1 query budget', async () => {
		const currentHash = 'a'.repeat(64);
		const staleHash = 'b'.repeat(64);
		const paths = Array.from({ length: 3 }, (_, index) => `notes/${index}.md`);
		const { bucket } = createMockR2Bucket();
		const { db } = createMockD1Database({
			files: Object.fromEntries(paths.map((path, index) => [path, {
				hash: currentHash,
				size: 1,
				storageKey: `current-${index}`,
			}])),
		});

    type PreparedMock = typeof db.prepare;
    const commits: number[] = [];
    let pending = Promise.resolve();
    const commitUpload: typeof commitStagedFile = (bucket, db, params) => {
      const result = pending.then(async () => {
        const before = (db.prepare as PreparedMock).mock.calls.length;
        const committed = await commitStagedFile(bucket, db, params);
        commits.push((db.prepare as PreparedMock).mock.calls.length - before);
        return committed;
      });
      pending = result.then(() => undefined);
      return result;
    };
		const response = await handleBatchUpload(
			new Request('https://worker.test/sync/batch-upload', {
				method: 'POST',
				body: JSON.stringify({
					files: paths.map((path) => ({
						path,
						content: btoa('x'),
						operationId: createTestUploadOperationId(), expectedHash: staleHash,
					})),
				}),
			}),
			bucket,
			db,
      commitUpload,
		);

		expect(response.status).toBe(200);
		const responseBody = await responseJson(response) as {
			success: boolean;
			results: Array<{ code?: string; status?: number; currentHash?: string | null }>;
		};
		expect(responseBody.success).toBe(false);
		expect(responseBody.results).toHaveLength(paths.length);
		expect(responseBody.results.every((result) =>
			result.code === 'version_conflict'
			&& result.status === 409
			&& result.currentHash === currentHash,
		)).toBe(true);
		// Upload staging and each serialized commit have separate Worker/DO query budgets.
		expect(db.prepare.mock.calls.length).toBeGreaterThan(0);
		expect(db.prepare.mock.calls.length - commits.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(48);
    expect(Math.max(...commits)).toBeLessThanOrEqual(50);
	});

	it('rejects stale uploads without replacing the committed object', async () => {
		const currentHash = 'a'.repeat(64);
		const staleHash = 'b'.repeat(64);
		const managedKey = `__crate__/files/${currentHash}/current`;
		const { bucket, store } = createMockR2Bucket({ [managedKey]: 'current' });
		const { db } = createMockD1Database({
			files: {
				'notes/test.md': { hash: currentHash, size: 7, storageKey: managedKey },
			},
		});

		const response = await handleUpload(
			new Request('https://worker.test/sync/upload?path=notes/test.md', {
				method: 'PUT',
				body: 'stale update',
				headers: { 'X-Crate-Upload-Operation': createTestUploadOperationId(),
					'X-Crate-Expected-Hash': staleHash },
			}),
			bucket,
			db,
		);

		expect(response.status).toBe(409);
		expect(await responseJson(response)).toEqual(expect.objectContaining({
			success: false,
			code: 'version_conflict',
			currentHash,
		}));
		expect(new TextDecoder().decode(store.get(managedKey)?.body)).toBe('current');
		expect(store.size).toBe(1);
	});

	it('rejects stale deletes without removing the committed file', async () => {
		const currentHash = 'c'.repeat(64);
		const managedKey = `__crate__/files/${currentHash}/current`;
		const { bucket, store } = createMockR2Bucket({ [managedKey]: 'current' });
		const { db, files } = createMockD1Database({
			files: {
				'notes/test.md': { hash: currentHash, size: 7, storageKey: managedKey },
			},
		});

		const response = await handleDelete(
			new Request('https://worker.test/sync/delete', {
				method: 'POST',
				body: JSON.stringify({ path: 'notes/test.md', operationId: createTestUploadOperationId(), expectedHash: 'd'.repeat(64), expectedRevision: managedKey }),
				headers: { 'Content-Type': 'application/json' },
			}),
			bucket,
			db,
		);

		expect(response.status).toBe(409);
		expect(await responseJson(response)).toEqual(expect.objectContaining({
			success: false,
			code: 'version_conflict',
			currentHash,
		}));
		expect(files.has('notes/test.md')).toBe(true);
		expect(store.has(managedKey)).toBe(true);
	});

	it('returns structured version conflicts for stale batch deletes', async () => {
		const currentHash = 'e'.repeat(64);
		const { bucket } = createMockR2Bucket();
		const { db, files } = createMockD1Database({
			files: {
				'notes/test.md': { hash: currentHash, size: 7, storageKey: 'current-key' },
			},
		});

		const response = await handleBatchDelete(
			new Request('https://worker.test/sync/batch-delete', {
				method: 'POST',
				body: JSON.stringify({
					files: [{ path: 'notes/test.md', operationId: createTestUploadOperationId(), expectedHash: 'f'.repeat(64), expectedRevision: 'current-key' }],
				}),
				headers: { 'Content-Type': 'application/json' },
			}),
			bucket,
			db,
		);

		expect(response.status).toBe(200);
		expect(await responseJson(response)).toEqual({
			success: false,
			deleted: [],
			errors: [{
				path: 'notes/test.md',
				error: 'Remote file changed since it was read',
				code: 'version_conflict',
				status: 409,
				currentHash,
			}],
		});
		expect(files.has('notes/test.md')).toBe(true);
	});

	it('preflights batch download size before reading R2 objects', async () => {
		const { bucket } = createMockR2Bucket();
		const { db } = createMockD1Database({
			files: {
				'a.bin': { hash: 'a'.repeat(64), size: 5 * 1024 * 1024, storageKey: 'a' },
				'b.bin': { hash: 'b'.repeat(64), size: 5 * 1024 * 1024, storageKey: 'b' },
			},
		});

		const response = await handleBatchDownload(
			new Request('https://worker.test/sync/batch-download', {
				method: 'POST',
				body: JSON.stringify({ paths: ['a.bin', 'b.bin'] }),
				headers: { 'Content-Type': 'application/json' },
			}),
			bucket,
			db,
		);

		expect(response.status).toBe(413);
		expect(bucket.get).not.toHaveBeenCalled();
	});
});
