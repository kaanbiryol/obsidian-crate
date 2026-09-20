import { expect, it, vi } from 'vitest';
import { createHarness, getPendingPaths, toArrayBuffer } from './engine-test-harness';
import { computeHash } from './hasher';

async function setup() {
 const h = createHarness();
 const base = toArrayBuffer('before');
 const hash = await computeHash(base);
 h.localManifest.setEntry('note.md', { hash, size: base.byteLength, modified: '' });
 h.vault.adapter.stat.mockResolvedValue({ type: 'file', size: 5, mtime: 1 });
 h.vault.adapter.exists.mockResolvedValue(true);
 const readBinary = vi.fn<(path: string) => Promise<ArrayBuffer>>(async path => path === 'note.md' ? toArrayBuffer('after') : base);
 h.vault.adapter.readBinary = readBinary;
 for (const method of Object.values(h.api)) {
  if (vi.isMockFunction(method)) method.mockClear().mockImplementation(() => { throw new Error('Network unavailable'); });
 }
 return { ...h, readBinary };
}

it('uses the on-disk Markdown cache offline without calling the server', async () => {
 const h = await setup();
 expect(await h.engine.loadPendingDiff('note.md', false)).toMatchObject({ before: 'before', after: 'after', kind: 'modified' });
 for (const method of Object.values(h.api)) if (vi.isMockFunction(method)) expect(method).not.toHaveBeenCalled();
});

it('keeps a modified status when the cached baseline is missing or corrupt', async () => {
 const h = await setup();
 h.vault.adapter.exists.mockResolvedValue(false);
 expect(await h.engine.loadPendingDiff('note.md', false)).toMatchObject({ baselineUnavailable: true, kind: 'modified' });
 h.vault.adapter.exists.mockResolvedValue(true);
 h.readBinary.mockResolvedValue(toArrayBuffer('corrupt'));
 expect(await h.engine.loadPendingDiff('note.md', false)).toMatchObject({ baselineUnavailable: true, kind: 'modified' });
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
 const h = createHarness();
 const base = toArrayBuffer('last synced');
 const hash = await computeHash(base);
 const baseline = { hash, size: base.byteLength, modified: '', revision: 'last-synced-revision' };
 h.localManifest.setEntry('note.md', baseline);
 getPendingPaths(h.engine).add('delete:note.md');
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
