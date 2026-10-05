import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHarness, toArrayBuffer } from './engine-test-harness';
import { computeHash } from './hasher';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function setup(path = 'note.md') {
 const h = createHarness({ automaticSync: false });
 const base = toArrayBuffer('before');
 const hash = await computeHash(base);
 const baseline = { hash, size: base.byteLength, modified: '' };
 h.localManifest.setEntry(path, baseline);
 const remote = { getFileMetadata: vi.fn(), listFileVersions: vi.fn(), previewFileVersion: vi.fn() };
 Object.assign(h.api, remote);
 h.vault.adapter.stat.mockResolvedValue({ type: 'file', size: 5, mtime: 1 });
 h.vault.adapter.exists.mockResolvedValue(true);
 const readBinary = vi.fn<(filePath: string) => Promise<ArrayBuffer>>(async filePath => filePath === path ? toArrayBuffer('after') : base);
 h.vault.adapter.readBinary = readBinary;
 for (const method of Object.values(h.api)) {
  if (vi.isMockFunction(method)) method.mockClear().mockImplementation(() => { throw new Error('Network unavailable'); });
 }
 return { ...h, readBinary, remote, base, baseline };
}

it('uses the on-disk Markdown cache offline without calling the server', async () => {
 const h = await setup();
 expect(await h.engine.loadPendingDiff('note.md', false)).toMatchObject({ before: 'before', after: 'after', kind: 'modified' });
 for (const method of Object.values(h.api)) if (vi.isMockFunction(method)) expect(method).not.toHaveBeenCalled();
});

it('allows retry when the cached baseline is missing or corrupt and the server is offline', async () => {
 const h = await setup();
 h.vault.adapter.exists.mockResolvedValue(false);
 await expect(h.engine.loadPendingDiff('note.md', false)).rejects.toThrow('Network unavailable');
 h.vault.adapter.exists.mockResolvedValue(true);
 h.readBinary.mockResolvedValue(toArrayBuffer('corrupt'));
 await expect(h.engine.loadPendingDiff('note.md', false)).rejects.toThrow('Network unavailable');
});

it.each(['note.md', '.obsidian/plugins/obsidian-minimal-settings/data.json'])('loads the verified server baseline for %s without changing sync state', async path => {
 const h = await setup(path);
 h.vault.adapter.exists.mockResolvedValue(false);
 h.remote.getFileMetadata.mockResolvedValue({ files: { [path]: h.baseline } });
 h.api.downloadFile.mockResolvedValue({ content: h.base });
 h.localManifest.setEntry.mockClear();
 h.engine.onFileChange({ path } as never);
 expect(await h.engine.loadPendingDiff(path, false)).toMatchObject({ before: 'before', after: 'after', kind: 'modified' });
 expect(h.remote.getFileMetadata).toHaveBeenCalledWith([path]);
 expect(h.api.downloadFile).toHaveBeenCalledWith(path);
 expect(h.remote.listFileVersions).not.toHaveBeenCalled();
 expect(h.engine.getPendingPaths()).toEqual([path]);
 expect(h.localManifest.setEntry).not.toHaveBeenCalled();
 expect(h.localManifest.save).not.toHaveBeenCalled();
 expect(h.api.uploadFile).not.toHaveBeenCalled();
 expect(h.vault.adapter.writeBinary).not.toHaveBeenCalled();
});

it('checks unchanged JSON locally without contacting the server', async () => {
 const path = '.obsidian/plugins/obsidian-minimal-settings/data.json';
 const h = await setup(path);
 h.readBinary.mockResolvedValue(h.base);
 expect(await h.engine.loadPendingDiff(path, false)).toMatchObject({ unchanged: true, before: 'before', after: 'before' });
 expect(h.remote.getFileMetadata).not.toHaveBeenCalled();
});

it('rejects a preview if sync advances its baseline during a server read', async () => {
 const h = await setup();
 h.vault.adapter.exists.mockResolvedValue(false);
 h.remote.getFileMetadata.mockResolvedValue({ files: { 'note.md': h.baseline } });
 h.api.downloadFile = vi.fn(async () => {
  h.localManifest.getEntry.mockReturnValue(undefined);
  return { content: h.base };
 });
 await expect(h.engine.loadPendingDiff('note.md', false)).rejects.toThrow('Pending changes were updated');
});

it('rejects a preview if sync changes its baseline during a local read', async () => {
 const h = await setup();
 h.readBinary.mockImplementation(() => {
  h.localManifest.getEntry.mockReturnValue(undefined);
  return Promise.resolve(toArrayBuffer('after'));
 });
 await expect(h.engine.loadPendingDiff('note.md', false)).rejects.toThrow('Pending changes were updated');
});

it('discards a local deletion offline and preserves the last-synced revision', async () => {
 const h = createHarness({ automaticSync: false });
 const base = toArrayBuffer('last synced');
 const hash = await computeHash(base);
 const baseline = { hash, size: base.byteLength, modified: '', revision: 'last-synced-revision' };
 h.localManifest.setEntry('note.md', baseline);
 h.engine.onFileDelete({ path: 'note.md' } as never);
 let restored = false;
 h.vault.adapter.exists.mockImplementation((path: string) => path !== 'note.md' || restored);
 h.vault.adapter.stat.mockImplementation(async (path: string) => path === 'note.md' && !restored ? null : { type: 'file', size: base.byteLength, mtime: 1 });
 h.vault.adapter.readBinary = vi.fn(async () => base);
 h.vault.createBinary.mockImplementation(() => { restored = true; });
 for (const [name, method] of Object.entries(h.api)) {
  if (name !== 'isConfigured' && vi.isMockFunction(method)) method.mockClear().mockImplementation(() => { throw new Error('Offline'); });
 }
 const review = await h.engine.createPendingDiscard(['delete:note.md']);
 await review.discard();
 expect(restored).toBe(true);
 expect(h.localManifest.getEntry('note.md')).toMatchObject({ hash, revision: baseline.revision });
 expect(h.engine.getPendingPaths()).not.toContain('delete:note.md');
 for (const [name, method] of Object.entries(h.api)) {
  if (name !== 'isConfigured' && vi.isMockFunction(method)) expect(method).not.toHaveBeenCalled();
 }
});
