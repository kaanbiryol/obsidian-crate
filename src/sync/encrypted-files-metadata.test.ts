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

function precondition() {
	const cipher = (i: number) => `c${i.toString(16).padStart(63, '0')}`;
	const requestJson = vi.fn(async (path: string, init: { body: string }) => {
		if (path === '/sync/metadata') {
			const { paths } = JSON.parse(init.body) as { paths: string[] };
			return { files: Object.fromEntries(paths.map(p => {
				const i = Number(p.slice(2, -3));
				return [p, { hash: cipher(i), size: 9, modified: '2026-10-01T12:00:00Z', revision: `rev-${i}` }];
			})) };
		}
		const { revisions } = JSON.parse(init.body) as { revisions: string[] };
		return { descriptors: Object.fromEntries(revisions.map(revision => [revision, { path: `n/${revision.slice(4)}.md`, revision }])) };
	});
	const requests = (path: string) => requestJson.mock.calls.filter(([called]) => called === path).length;
	const files = () => EncryptedFiles.create({ requestJson } as unknown as WorkerApiHttpClient, {} as never, async () => null);
	const request = (i: number, expected = `plain-rev-${i}`) => ({ path: `n/${i}.md`, expected, revision: `rev-${i}` });
	return { cipher, requestJson, requests, files, request };
}

it('checks a batch of encrypted deletes with one metadata request', async () => {
	const { cipher, requests, files, request } = precondition();
	const hashes = await (await files()).expectedHashes(Array.from({ length: 8 }, (_, i) => request(i)));
	expect(hashes).toEqual(Array.from({ length: 8 }, (_, i) => cipher(i)));
	// Before: one /sync/metadata and one /encryption/metadata per file.
	expect(requests('/sync/metadata')).toBe(1);
	expect(requests('/encryption/metadata')).toBe(1);
});

it('skips the server check for a revision already verified in this session', async () => {
	const { cipher, requestJson, files, request } = precondition();
	const encryption = await files();
	await encryption.metadata([0, 1].map(i => ({ path: `n/${i}.md`, entry: { hash: cipher(i), size: 9, revision: `rev-${i}` } })));
	requestJson.mockClear();
	await expect(encryption.expectedHashes([request(0), request(1)])).resolves.toEqual([cipher(0), cipher(1)]);
	expect(requestJson).not.toHaveBeenCalled();
});

it('still rejects a file whose plaintext no longer matches the synced baseline', async () => {
	const { files, request } = precondition();
	await expect((await files()).expectedHashes([request(0), request(1, 'plain-older')])).rejects.toMatchObject({ status: 409, code: 'version_conflict' });
});

it('resolves an upload batch once and lets each file use its result only once', async () => {
	const { cipher, requests, files } = precondition();
	const encryption = await files();
	await encryption.preloadExpected([0, 1, 2].map(i => ({ path: `n/${i}.md`, expected: `plain-rev-${i}` })));
	expect(requests('/sync/metadata')).toBe(1);
	const preloaded = (encryption as unknown as { preloaded: Map<string, { result: string }> }).preloaded;
	expect([...preloaded.values()].map(entry => entry.result)).toEqual([0, 1, 2].map(cipher));
	await encryption.preloadExpected([]);
	expect(preloaded.size).toBe(0);
});
