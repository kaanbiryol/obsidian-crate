import { expect, it, vi } from 'vitest';
import { EncryptedFiles } from './encrypted-files';
import { ENCRYPTION_METADATA_BATCH } from '../protocol/sync-limits';
import type { WorkerApiHttpClient } from './worker-api/http';

vi.mock('../encryption/file-format', async original => ({ ...await original<object>(), validateFileDescriptor: () => {} }));
vi.mock('../encryption/file-codec', async original => ({ ...await original<object>(),
	openFileMetadata: async (descriptor: { path: string; revision: string }) => ({ path: descriptor.path, hash: `plain-${descriptor.revision}`, size: 1 }) }));
vi.mock('../encryption/file-authority', () => ({ FileKeyAuthority: { fromVault: async () => ({ forPath: () => ({}) }) } }));

it('decrypts large inventories in bounded, overlapping batches and keeps their order', async () => {
	let active = 0, peak = 0;
	const requestJson = vi.fn(async (_path: string, init: { body: string }) => {
		active++; peak = Math.max(peak, active);
		await new Promise(resolve => setTimeout(resolve, 1));
		active--;
		const { revisions } = JSON.parse(init.body) as { revisions: string[] };
		expect(revisions.length).toBeLessThanOrEqual(ENCRYPTION_METADATA_BATCH);
		return { descriptors: Object.fromEntries(revisions.map(revision => [revision, { path: `n/${revision}.md`, revision }])) };
	});
	const files = await EncryptedFiles.create({ requestJson } as unknown as WorkerApiHttpClient, {} as never, async () => null);
	const count = ENCRYPTION_METADATA_BATCH * 5 + 7;
	const entries = Array.from({ length: count }, (_, index) => ({ path: `n/${index}.md`, entry: { hash: 'cipher', size: 9, revision: String(index) } }));
	const result = await files.metadata(entries);
	expect(requestJson).toHaveBeenCalledTimes(6);
	expect(peak).toBeGreaterThan(1);
	expect(peak).toBeLessThanOrEqual(4);
	expect(result.map(entry => entry.hash)).toEqual(entries.map(({ entry }) => `plain-${entry.revision}`));
});
