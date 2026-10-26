import { expect, it, vi } from 'vitest';
import type { ChangelogEntry } from '../../protocol/sync-types';
import { readIncrementalChangelog } from './incremental-changelog';
import { runIncrementalSync } from './incremental';
import { createIncrementalHarness } from './planner-test-harness';
import { SyncWorkerApi } from '../worker-api/sync';
import type { WorkerApiHttpClient } from '../worker-api/http';
import { EncryptedFiles } from '../encryption/encrypted-files';
import { createVaultKeyBundle } from '../../encryption/key-bundle';
import { sealFile } from '../../encryption/file-codec';

function entry(seq: number, path = 'note.md'): ChangelogEntry {
	return { seq, path, action: 'put', hash: `hash-${seq}`, size: 1, created_at: '2026-10-05T12:00:00Z' };
}

it('deduplicates across pages while following the last entry rather than the server watermark', async () => {
	const getChanges = vi.fn<Parameters<typeof readIncrementalChangelog>[0]['getChanges']>()
		.mockResolvedValueOnce({ changes: [entry(2), entry(3, 'other.md')], lastSeq: 9, hasMore: true })
		.mockResolvedValueOnce({ changes: [entry(5)], lastSeq: 9, hasMore: false });
	const result = await readIncrementalChangelog({ getChanges }, 1);
	expect(getChanges.mock.calls).toEqual([[1], [3]]);
	expect(result).toEqual({ changesByPath: new Map([['note.md', entry(5)], ['other.md', entry(3, 'other.md')]]), changeCount: 3, latestSeq: 9 });
});

it('discards partial inventory if a later page has expired', async () => {
	const getChanges = vi.fn<Parameters<typeof readIncrementalChangelog>[0]['getChanges']>()
		.mockResolvedValueOnce({ changes: [entry(2)], lastSeq: 9, hasMore: true })
		.mockResolvedValueOnce({ changes: [], lastSeq: 9, hasMore: false, cursorExpired: true });
	expect(await readIncrementalChangelog({ getChanges }, 1)).toBeNull();
});

it('rejects a repeated cursor instead of looping indefinitely', async () => {
	const getChanges = vi.fn(async () => ({ changes: [entry(2)], lastSeq: 9, hasMore: true }));
	await expect(readIncrementalChangelog({ getChanges }, 1)).rejects.toThrow('Changelog cursor did not advance');
	expect(getChanges).toHaveBeenCalledTimes(2);
});

it('does not fetch another page after cancellation', async () => {
	const lifetime = new AbortController();
	const getChanges = vi.fn(async () => {
		lifetime.abort();
		return { changes: [entry(2)], lastSeq: 9, hasMore: true };
	});
	await expect(readIncrementalChangelog({ getChanges }, 1, () => lifetime.signal.throwIfAborted())).rejects.toMatchObject({ name: 'AbortError' });
	expect(getChanges).toHaveBeenCalledOnce();
});

it('keeps paging past an encrypted page made only of deletes this device never synced', async () => {
	const created_at = '2026-10-25T12:00:00Z';
	const deletes = Array.from({ length: 5000 }, (_, index) => ({ seq: 11 + index, path: `gone/${index}.md`, action: 'delete', hash: '', size: 0, created_at }));
	let put!: ChangelogEntry;
	let descriptor: unknown;
	const requestJson = vi.fn(async (url: string) => {
		if (url === '/encryption/metadata') return { descriptors: { 'rev-1': descriptor } };
		if (url === '/sync/changes?since=10') return { changes: deletes, lastSeq: 5011, hasMore: true };
		if (url === '/sync/changes?since=5010') return { changes: [put], lastSeq: 5011, hasMore: false };
		throw new Error(`Unexpected request ${url}`);
	});
	const http = { requestJson } as unknown as WorkerApiHttpClient;
	const encryption = await EncryptedFiles.create(http, await createVaultKeyBundle(), async () => null);
	const sealed = await sealFile({ path: 'new.md', content: new TextEncoder().encode('new'), contentType: 'text/markdown' }, encryption.keys.forPath('new.md'));
	descriptor = sealed.descriptor;
	put = { seq: 5011, path: await encryption.paths.wireFor('new.md'), action: 'put', hash: sealed.hash, size: sealed.bytes.byteLength, created_at, revision: 'rev-1' };
	const api = new SyncWorkerApi(http);
	api.setEncryption(encryption);
	const harness = createIncrementalHarness({ settings: { lastSeq: 10 } });
	harness.context.files.getChanges = since => api.getChanges(since);
	const download = vi.fn(async () => {});
	harness.context.parallelDownloadAndSaveFiles = download;

	const result = await runIncrementalSync(harness.context, {});

	// Before: the empty first page ended paging and saved the server's last sequence.
	expect(requestJson.mock.calls.map(([url]) => url).filter(url => url.startsWith('/sync/changes'))).toEqual(['/sync/changes?since=10', '/sync/changes?since=5010']);
	expect(download).toHaveBeenCalledWith([expect.objectContaining({ path: 'new.md' })], expect.anything(), expect.any(Function), undefined);
	expect(result?.success).toBe(true);
	expect(harness.settings.lastSeq).toBe(5011);
});
