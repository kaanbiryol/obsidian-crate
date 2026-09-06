import { expect, it, vi } from 'vitest';
import { createTransferHarness, emptyResult } from './transfer-test-harness';
import { downloadAndSaveFile, parallelDownloadAndSaveFiles } from './transfer-download';
import { computeHash } from './hasher';
import { getLocalChanges } from './planner-local';
import { hasLocalFileChanges } from './local-file-changes';
import { LocalManifest } from './manifest';
import { processDiff } from './transfer-process';

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

it.each(['single', 'batch', 'merge'])('syncs an edit made after %s apply even after a persisted checkpoint restart', async mode => {
  const h = createTransferHarness();
  const path = 'note.md';
  const base = bytes('title\nbase\ntail\n');
  let content = mode === 'merge' ? bytes('title\nlocal\ntail\n') : base;
  let remote = bytes('title\nbase\nremote\n');
  const file = { path, extension: 'md', stat: { size: content.byteLength, mtime: 1000 } };
  const checkpoints = new Map<string, string>();
  Object.assign(h.adapter, {
    list: async () => ({ files: [], folders: [] }),
    write: async (key: string, value: string) => { checkpoints.set(key, value); },
    read: async (key: string) => checkpoints.get(key),
  });
  h.adapter.exists.mockImplementation(async (key: string) => key === path || checkpoints.has(key));
  h.adapter.remove.mockImplementation(async (key: string) => { checkpoints.delete(key); });
  h.adapter.stat.mockImplementation(async () => ({ type: 'file', ...file.stat }));
  h.adapter.readBinary.mockImplementation(async () => content);
  h.vault.getAbstractFileByPath.mockReturnValue(file);
  Object.assign(h.vault, { getFiles: () => [file] });
  h.vault.modifyBinary.mockImplementation(async (_file: unknown, next: ArrayBuffer) => {
    content = next; file.stat.size = next.byteLength; file.stat.mtime = 2000;
  });
  const app = { vault: h.vault };
  const plugin = { dir: '.obsidian/plugins/crate' };
  const manifest = new LocalManifest(app as never, plugin as never);
  manifest.setEntry(path, { hash: await computeHash(base), size: base.byteLength, modified: new Date(1000).toISOString() });
  const context = { ...h.context, localManifest: manifest, shouldIgnore: () => false,
    markdownBaseCache: { readBase: async () => base, putBase: vi.fn(async () => {}) } };
  const remoteHash = await computeHash(remote);
  h.api.downloadFile.mockResolvedValue({ content: remote, hash: remoteHash, size: remote.byteLength, revision: 'remote-revision' });
  h.api.batchDownload.mockResolvedValue({ files: [{ path, content: btoa(new TextDecoder().decode(remote)), hash: remoteHash, size: remote.byteLength, revision: 'remote-revision' }] });
  h.api.uploadFile.mockImplementation(async (_path: string, value: ArrayBuffer, hash: string) => { remote = value; return { success: true, hash, revision: 'uploaded-revision' }; });
  let edited = false;
  h.getModifiedIso.mockImplementation(async () => {
    if (!edited) { content = bytes(new TextDecoder().decode(content).replace('title', 'local')); file.stat.mtime = 3000; edited = true; }
    return new Date(file.stat.mtime).toISOString();
  });
  const request = { path, expectedLocalHash: await computeHash(content), expectedRemoteHash: remoteHash, remoteSize: remote.byteLength };
  if (mode === 'single') await downloadAndSaveFile(context, request, emptyResult());
  else if (mode === 'batch') await parallelDownloadAndSaveFiles(context, [request], emptyResult(), 1);
  else await processDiff(context, { path, action: 'conflict', localHash: request.expectedLocalHash, remoteHash, cause: 'concurrent-edit' }, {}, emptyResult());
  await manifest.save();
  const restarted = new LocalManifest(app as never, plugin as never);
  await restarted.load();
  const resumed = { ...context, localManifest: restarted };
  const actualHash = await computeHash(content);
  expect(restarted.getEntry(path)?.hash).not.toBe(actualHash);
  expect(await hasLocalFileChanges(h.vault as never, restarted, () => false)).toBe(true);
  expect(await getLocalChanges(resumed, 1)).toEqual([{ path, hash: actualHash }]);
  await processDiff(resumed, { path, action: 'upload', localHash: actualHash, remoteHash: await computeHash(remote), cause: 'local-edited' }, {}, emptyResult());
  expect(await computeHash(remote)).toBe(actualHash);
});
