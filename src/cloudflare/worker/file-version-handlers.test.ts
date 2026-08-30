import { describe, expect, it, vi } from 'vitest';
import { createMockR2Bucket } from '@/test/factories/cloudflare';
import { handleRestoreFileVersion } from './file-version-handlers';

describe('file version recovery', () => {
	it('refuses to restore retained content whose bytes do not match its recorded hash', async () => {
		const storageKey = '__crate__/files/retained/object';
		const { bucket } = createMockR2Bucket({ [storageKey]: 'wrong' });
		const version = {
			storage_key: storageKey,
			path: 'notes/a.md',
			hash: 'a'.repeat(64),
			size: 5,
			reason: 'deleted',
			created_at: '2026-01-01T00:00:00.000Z',
			expires_at: Date.now() + 60_000,
		};
		const statement = {
			bind: vi.fn(() => statement),
			first: vi.fn(async () => version),
		};
		const db = { prepare: vi.fn(() => statement) } as unknown as D1Database;

		const response = await handleRestoreFileVersion(new Request('https://worker.test/sync/restore-version', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ storageKey, expectedHash: null }),
		}), bucket, db);

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: 'Stored file version content failed integrity validation' });
	});
});
