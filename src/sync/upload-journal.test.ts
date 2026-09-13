import { DurableUploads } from './durable-uploads';
import { expect, it, vi } from 'vitest';
import { LocalManifest } from './manifest';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '@/cloudflare/worker/sync-engine-vault-test-harness';

function fixture() {
	const disk = new PersistentTestVault();
	const create = (authority = 'https://server.test') => new LocalManifest({ vault: disk.vault } as never, { dir: TEST_PLUGIN_DIR } as never, authority);
	const file = { intent: { kind: 'local' as const }, path: 'note.md', content: btoa('original'), hash: '0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5', size: 8, contentType: 'text/markdown', expectedHash: null };
	return { disk, create, file };
}

it('preserves settled receipts while promoting a newer temporary checkpoint across repeated crashes', async () => {
	const { disk, create, file } = fixture();
	const manifest = create();
	const [upload] = await manifest.uploadJournal.prepare([file], 20000);
	manifest.setEntry(file.path, { hash: file.hash, size: file.size, revision: 'revision', modified: '2026-09-09T00:00:00Z' });
	manifest.completeUpload(upload!.operationId);
	const write = disk.vault.adapter.write.bind(disk.vault.adapter);
	const fail = vi.spyOn(disk.vault.adapter, 'write').mockImplementation(async (path, bytes) => {
		if (path.endsWith('/file-manifest.json')) throw new Error('Main checkpoint unavailable');
		await write(path, bytes);
	});
	await expect(manifest.save()).rejects.toThrow('Main checkpoint unavailable');
	await manifest.close(); fail.mockRestore();
	const recovered = create(); await recovered.load();
	expect(recovered.uploadJournal.pending()).toEqual([]);
	expect(JSON.parse(disk.text(`${TEST_PLUGIN_DIR}/file-manifest.json`))).toMatchObject({ settledUploads: [upload!.operationId] });
	await recovered.close();
	const again = create(); await again.load();
	expect(again.uploadJournal.pending()).toEqual([]);
	expect(again.getEntry(file.path)?.revision).toBe('revision');
});

it('refuses a foreign or torn journal without deleting its only copy', async () => {
	const { disk, create, file } = fixture();
	const manifest = create();
	const [upload] = await manifest.uploadJournal.prepare([file], 20000);
	const path = `${TEST_PLUGIN_DIR}/pending-uploads/${upload!.operationId}.json`;
	await expect(create('https://another.test').load()).rejects.toThrow('another server');
	expect(disk.has(path)).toBe(true);
	disk.write(path, '{"truncated":');
	await expect(create().load()).rejects.toThrow('Unreadable upload journal');
	expect(disk.text(path)).toBe('{"truncated":');
});


it('drops already-pruned receipt IDs on restart instead of accumulating them forever', async () => {
	const { create, file, disk } = fixture();
	const manifest = create();
	const [upload] = await manifest.uploadJournal.prepare([file], 20000);
	manifest.setEntry(file.path, { hash: file.hash, size: file.size, revision: 'revision', modified: '2026-09-09T00:00:00Z' });
	manifest.completeUpload(upload!.operationId);
	await manifest.save(); await manifest.close();
	const reopened = create(); await reopened.load();
	expect(reopened.uploadJournal.completedSnapshot()).toEqual([]);
	reopened.setEntry(file.path, { ...reopened.getEntry(file.path)!, modified: '2026-09-10T00:00:00Z' });
	await reopened.save();
	expect(JSON.parse(disk.text(`${TEST_PLUGIN_DIR}/file-manifest.json`))).not.toHaveProperty('settledUploads');
});

it.each(['legacy', 'unknown-intent', 'damaged-content', 'damaged-preimage'])('preserves and refuses an unsafe %s upload record', async failure => {
	const { disk, create, file } = fixture();
	const [upload] = await create().uploadJournal.prepare([file], 20000);
	const path = `${TEST_PLUGIN_DIR}/pending-uploads/${upload!.operationId}.json`;
	const raw = JSON.parse(disk.text(path)) as { version?: number; file: Record<string, unknown> };
	if (failure === 'legacy') delete raw.version;
	if (failure === 'unknown-intent') raw.file.intent = { kind: 'future' };
	if (failure === 'damaged-content') raw.file.content = btoa('tampered');
	if (failure === 'damaged-preimage') raw.file.intent = { kind: 'merge', preimage: { content: btoa('damaged'), hash: file.hash, size: file.size } };
	const bytes = JSON.stringify(raw); disk.write(path, bytes);
	await expect(create().load()).rejects.toThrow();
	expect(disk.text(path)).toBe(bytes);
});

it.each([3, 17])('checkpoints recovered receipts before another interruption (%i uploads)', async count => {
    const { create, file } = fixture();
    const manifest = create();
    const day = Math.floor(Date.now() / 86400000);
    await manifest.uploadJournal.prepare(Array.from({ length: count }, (_, index) => ({ ...file, path: `note-${index}.md` })), day);
    let dispatched = 0;
    const save = vi.spyOn(manifest, 'save');
    const recovery = new DurableUploads(manifest, {
        getServerInfo: async () => ({ reminderOperationDay: day }),
        batchUpload: async files => ({ success: false, results: files.map(file => {
            dispatched++;
            return dispatched === count
                ? { success: false as const, path: file.path, error: 'Connection interrupted again', status: 503 }
                : { success: true as const, path: file.path, hash: file.hash, revision: `revision-${dispatched}` };
        }) }),
        uploadFile: async (path: string, _content: ArrayBuffer, hash: string) => {
            dispatched++;
            if (dispatched === count) {
                if (count === 17) expect(save).toHaveBeenCalledOnce();
                throw new Error('Connection interrupted again');
            }
            return { success: true, path, hash, revision: `revision-${dispatched}` };
        },
    }, { putBase: async () => {} } as never, crypto.randomUUID());
    const progress = vi.fn();
    await expect(recovery.recover(progress)).rejects.toThrow('Connection interrupted again');
    expect(progress).toHaveBeenNthCalledWith(1, 0, count);
    expect(progress).toHaveBeenLastCalledWith(count - 1, count);
    await manifest.close();
    const restarted = create();
    await restarted.load();
    expect(restarted.uploadJournal.pending().map(entry => entry.path)).toEqual([`note-${count - 1}.md`]);
    await restarted.close();
});


it('recovers 24 small uploads in three requests using their original identities and bytes', async () => {
  const { create, file } = fixture(); const manifest = create();
  const original = await manifest.uploadJournal.prepare(Array.from({ length: 24 }, (_, i) => ({ ...file, path: `${i}.md` })), 20000);
  const batchUpload = vi.fn(async (files: typeof original) => ({ success: true, results: files.map(f => ({ path: f.path, success: true, hash: f.hash, revision: 'r' })) }));
  const uploadFile = vi.fn(); const getServerInfo = vi.fn(); const progress = vi.fn();
  const recovery = new DurableUploads(manifest, { batchUpload, uploadFile, getServerInfo } as never, { putBase: async () => {} } as never, crypto.randomUUID());
  await recovery.recover(progress);
  expect(batchUpload.mock.calls.map(([files]) => files.length)).toEqual([8, 8, 8]);
  expect(batchUpload.mock.calls.flatMap(([files]) => files.map(f => [f.operationId, f.content, f.expectedHash]))).toEqual(original.map(f => [f.operationId, f.content, f.expectedHash]));
  expect(uploadFile).not.toHaveBeenCalled(); expect(getServerInfo).not.toHaveBeenCalled();
  expect(progress).toHaveBeenLastCalledWith(24, 24);
  await manifest.close(); const restarted = create(); await restarted.load();
  expect(restarted.uploadJournal.pending()).toEqual([]); await restarted.close();
});

it('checkpoints healthy batch members while retaining only the unresolved upload', async () => {
  const { create, file } = fixture(); const manifest = create();
  await manifest.uploadJournal.prepare(['a', 'b', 'c'].map(path => ({ ...file, path: `${path}.md` })), 20000);
  const recovery = new DurableUploads(manifest, {
    getServerInfo: vi.fn(), uploadFile: vi.fn(),
    batchUpload: async files => ({ success: false, results: files.map(f => f.path === 'b.md'
      ? { path: f.path, success: false as const, status: 503, error: 'Retry needed' }
      : { path: f.path, success: true as const, hash: f.hash, revision: 'r' }) }),
  }, { putBase: async () => {} } as never, crypto.randomUUID());
  const progress = vi.fn();
  await expect(recovery.recover(progress)).rejects.toThrow('Retry needed');
  expect(progress).toHaveBeenLastCalledWith(2, 3);
  await manifest.close(); const restarted = create(); await restarted.load();
  expect(restarted.uploadJournal.pending().map(f => f.path)).toEqual(['b.md']); await restarted.close();
});

it('keeps the whole batch when its receipt list is invalid', async () => {
  const { create, file } = fixture(); const manifest = create();
  await manifest.uploadJournal.prepare(['a', 'b'].map(path => ({ ...file, path: `${path}.md` })), 20000);
  const recovery = new DurableUploads(manifest, { getServerInfo: vi.fn(), uploadFile: vi.fn(),
    batchUpload: async () => ({ success: true, results: [{ path: 'a.md', hash: file.hash, success: true, revision: 'r' }] }),
  }, { putBase: async () => {} } as never, crypto.randomUUID());
  const progress = vi.fn();
  await expect(recovery.recover(progress)).rejects.toThrow('Invalid upload receipt batch');
  expect(progress).toHaveBeenCalledExactlyOnceWith(0, 2);
  expect(manifest.uploadJournal.pending()).toHaveLength(2); await manifest.close();
});
