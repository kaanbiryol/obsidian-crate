import { afterEach, expect, it, vi } from 'vitest';
import type CratePlugin from '../plugin/CratePlugin';
import { createRuntimeHarness } from '../sync/runtime-test-harness';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '../cloudflare/worker/sync-engine-vault-test-harness';
import { addReminderScope, createVaultKeyBundle, generateRecoveryCode } from '../encryption/key-bundle';
import { saveEncryptionKeys } from '../plugin/encryption-storage';
import { SECRET_KEYS } from '../plugin/settings-types';
import { captureAuthority, parseCaptureRecord, ReadingCaptureOutbox } from './data/capture-outbox';
import { recoverMovedReadingCaptures } from './capture-folder-recovery';
import { WorkerApiHttpClient } from '../sync/worker-api/http';
import { SyncApiClient } from '../sync/api';
import { LocalManifest } from '../sync/manifest';
import { assertRenamePreserved } from '../sync/rename-dependencies';
import { computeHash } from '../sync/hasher';
import { encryptJson, importEncryptionSecret } from '../encryption/envelope';

vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: vi.fn(), unmount: vi.fn() }) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function setup() {
  const h = createRuntimeHarness({ reading: { enabled: true, folderPath: 'Articles' } }), disk = new PersistentTestVault();
  const plugin = Object.assign(h.plugin, { settings: h.settings, secretStorage: h.secretStorage }) as unknown as CratePlugin;
  Object.assign(plugin.app, { vault: disk.vault }); plugin.manifest.dir = TEST_PLUGIN_DIR; plugin.manifest.id = 'crate';
  Object.assign(disk.vault, {
    getMarkdownFiles: () => disk.vault.getFiles().filter(file => file.extension === 'md'),
    getAllLoadedFiles: () => disk.vault.getFiles(),
    read: async (file: { path: string }) => disk.text(file.path),
    create: async (path: string, content: string) => disk.vault.createBinary(path, new TextEncoder().encode(content).buffer),
  });
  const keys = addReminderScope(createVaultKeyBundle(), 'Articles', 'reading');
  saveEncryptionKeys(plugin.secretStorage, keys, await generateRecoveryCode());
  const directory = `${TEST_PLUGIN_DIR}/reading-captures`; await disk.vault.adapter.mkdir(directory);
  const box = new ReadingCaptureOutbox({ list: async () => [], read: async key => disk.text(`${directory}/${key}`),
    write: async (key, raw) => disk.write(`${directory}/${key}`, raw), remove: async () => {} },
  await captureAuthority(h.settings.workerUrl, h.secretStorage.get(SECRET_KEYS.AUTH_TOKEN)), 'Reading', new AbortController().signal);
  const item = await box.add('https://example.com/private', 'Private article');
  const queued = `${directory}/${item.crate_reading_id}.json`, raw = disk.text(queued), record = parseCaptureRecord(raw);
  const manifest = vi.spyOn(SyncApiClient.prototype, 'getManifest').mockResolvedValue({ version: 1, files: {} });
  const request = vi.spyOn(WorkerApiHttpClient.prototype, 'requestJson').mockResolvedValue({ receipts: [], retryValid: true });
  const accept = async (text: string) => {
    const source = 'Reading/Original.md', bytes = new TextEncoder().encode(text).buffer;
    const entry = { hash: await computeHash(bytes), size: bytes.byteLength, revision: 'accepted', modified: '2026-01-01T00:00:00Z' };
    manifest.mockResolvedValue({ version: 1, files: { [source]: entry } });
    vi.spyOn(SyncApiClient.prototype, 'downloadFile').mockResolvedValue({ ...entry, content: bytes, contentType: 'text/markdown' });
    const hash = await computeHash(new TextEncoder().encode(JSON.stringify({ action: 'capture', body: record.body })).buffer);
    request.mockResolvedValue({ receipts: [{ kind: 'reading', requestHash: hash, envelope: await encryptJson({ requestHash: hash, response: { saved: true, id: item.crate_reading_id } }, await importEncryptionSecret(keys.vault), { vaultId: keys.vaultId, scopeId: 'vault', objectId: record.body.operationId, purpose: 'reminder' }) }], retryValid: true });
    return { source, entry };
  };
  return { plugin, disk, queued, raw, record, request, accept };
}

it('materializes an unsent old-folder bookmark locally without dispatching another capture', async () => {
  const h = await setup(); await recoverMovedReadingCaptures(h.plugin);
  expect(h.disk.has(h.queued)).toBe(false);
  const path = h.disk.paths()[0]!; expect(path).toMatch(/^Articles\/Article - /);
  expect(h.disk.text(path)).toBe(h.record.note);
  expect(h.request.mock.calls.every(([path, options]) => path.startsWith('/encryption/capture-recovery?') && options === undefined)).toBe(true);
});

it('preserves a remotely accepted article and prevents deleting its old copy before upload', async () => {
  const h = await setup(), text = h.record.note + '\nDownloaded article and private highlights\n';
  const { source } = await h.accept(text); await recoverMovedReadingCaptures(h.plugin);
  const path = h.disk.paths()[0]!; expect(h.disk.text(path)).toBe(text); expect(h.disk.has(h.queued)).toBe(false);
  const manifest = new LocalManifest(h.plugin.app, h.plugin.manifest, h.plugin.settings.workerUrl); await manifest.load();
  expect(manifest.renameDestination(source)).toBe(path);
  await expect(assertRenamePreserved(manifest, h.disk.vault, source)).rejects.toThrow('renamed file is uploaded');
  await manifest.close();
});

it('retains exact captures on disk failure and resumes without overwriting local edits or duplicating a note', async () => {
  const h = await setup(); await h.accept(h.record.note + '\nRemote content');
  // Fail specifically at capture removal, after the rename checkpoint is durable.
  const real = h.disk.vault.adapter.remove.bind(h.disk.vault.adapter);
  const failure = vi.spyOn(h.disk.vault.adapter, 'remove').mockImplementation(async path => { if (path === h.queued) throw new Error('disk full'); else await real(path); });
  await expect(recoverMovedReadingCaptures(h.plugin)).rejects.toThrow('disk full');
  expect(h.disk.text(h.queued)).toBe(h.raw); expect(h.disk.paths()).toHaveLength(1);
  const path = h.disk.paths()[0]!; h.disk.write(path, h.disk.text(path) + '\nLocal edits'); failure.mockRestore();
  await recoverMovedReadingCaptures(h.plugin);
  expect(h.disk.paths()).toEqual([path]); expect(h.disk.text(path)).toContain('Local edits'); expect(h.disk.has(h.queued)).toBe(false);
});

it.each(['expired', 'foreign', 'changed'] as const)('preserves captures when recovery is %s', async cause => {
  const h = await setup();
  if (cause === 'expired') h.request.mockResolvedValue({ receipts: [], retryValid: false });
  if (cause === 'foreign') h.disk.write(h.queued, JSON.stringify({ ...h.record, authority: 'another-server' }));
  if (cause === 'changed') h.request.mockImplementation(async () => { h.plugin.settings.reading.folderPath = 'Moved again'; return { receipts: [], retryValid: true }; });
  await expect(recoverMovedReadingCaptures(h.plugin)).rejects.toThrow();
  expect(h.disk.has(h.queued)).toBe(true); expect(h.disk.paths()).toEqual([]);
});

it('never acknowledges deletion of an unmerged remote article over a local bookmark', async () => {
  const h = await setup(); await h.accept(h.record.note + '\nDownloaded content and highlights');
  await h.disk.vault.createFolder('Articles'); h.disk.write('Articles/Local.md', h.record.note + '\nLocal annotations');
  await expect(recoverMovedReadingCaptures(h.plugin)).rejects.toThrow('copies differ');
  expect(h.disk.text(h.queued)).toBe(h.raw);
  const manifest = new LocalManifest(h.plugin.app, h.plugin.manifest, h.plugin.settings.workerUrl); await manifest.load();
  expect(manifest.getEntry('Reading/Original.md')).toBeUndefined(); expect(manifest.renameDestination('Reading/Original.md')).toBeUndefined(); await manifest.close();
});

it('does not create a duplicate when the original article has not moved locally', async () => {
  const h = await setup(), { source } = await h.accept(h.record.note);
  await h.disk.vault.createFolder('Reading'); h.disk.write(source, h.record.note);
  await expect(recoverMovedReadingCaptures(h.plugin)).rejects.toThrow('still exists locally');
  expect(h.disk.paths()).toEqual([source]); expect(h.disk.text(h.queued)).toBe(h.raw);
});
