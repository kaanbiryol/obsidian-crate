import { afterEach, expect, it, vi } from 'vitest';
import { addReminderScope, createVaultKeyBundle, generateRecoveryCode, moveEncryptionScopes, sealRecoveryBundle } from '../encryption/key-bundle';
import { createEncryptionState } from '../encryption/server-state';
import { readFolderMoves, writeFolderMoves } from '../plugin/encryption-folder-move-journal';
import { SecretStorageService } from '../plugin/secret-storage';
import { SECRET_KEYS } from '../plugin/settings-types';
import { buildPersistedCrateSettings, normalizeCrateSettings } from '../plugin/settings';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '@/test/factories/sync-vault';
import { LocalManifest } from './manifest';
import { getCheckpointAuthority } from './worker-url';
import { WorkerApiHttpClient } from './worker-api/http';
import { createRuntimeHarness } from './runtime-test-harness';
import { resetStoredSyncState } from './runtime-history';

afterEach(() => vi.restoreAllMocks());
const oldUrl = 'https://old.trycloudflare.com', newUrl = 'https://new.trycloudflare.com';
async function setup() {
  const h = createRuntimeHarness({ workerUrl: oldUrl, automaticSync: false, lastSeq: 17 });
  const raw = new Map<string, string>();
  const setSecret = vi.fn((id: string, value: string) => { raw.set(id, value); });
  const storage = new SecretStorageService({ secretStorage: { getSecret: (id: string) => raw.get(id), setSecret } } as never, () => h.settings.workerUrl);
  h.secretStorage.get.mockImplementation(key => storage.get(key as never));
  h.secretStorage.set.mockImplementation((key, value) => storage.set(key as never, value));
  h.secretStorage.delete.mockImplementation(key => storage.delete(key as never));
  Object.assign(h.secretStorage, { forScope: (scope: string) => storage.forScope(scope) });
  const before = addReminderScope(createVaultKeyBundle(), 'Reading', 'reading');
  const bundle = moveEncryptionScopes(before, 'Reading', 'Articles'), recovery = await generateRecoveryCode();
  storage.set(SECRET_KEYS.AUTH_TOKEN, 'token');
  storage.set(SECRET_KEYS.ENCRYPTION_KEYS, JSON.stringify(bundle));
  storage.set(SECRET_KEYS.ENCRYPTION_RECOVERY, recovery);
  writeFolderMoves(storage, { version: 1, moves: [{ id: 'move', from: 'Reading', to: 'Articles', target: bundle }] });
  const state = { ...createEncryptionState(before, await sealRecoveryBundle(before, recovery)), mode: 'active' as const };
  const request = vi.spyOn(WorkerApiHttpClient.prototype, 'requestJson').mockResolvedValue({ encryption: state });
  const controller = new AbortController();
  const move = (address = newUrl) => h.runtime.updateEncryptedServerAddress(address, controller.signal,
    { workerUrl: h.settings.workerUrl, authToken: 'token' });
  return { ...h, storage, setSecret, bundle, recovery, request, state, move, controller };
}

it('relocates unfinished conversion despite a prior server generation and preserves all local recovery work across restarts', async () => {
  const h = await setup(), disk = new PersistentTestVault();
  const manifest = new LocalManifest({ vault: disk.vault } as never, { dir: TEST_PLUGIN_DIR } as never, oldUrl);
  const file = { intent: { kind: 'local' as const }, path: 'Articles/note.md', content: btoa('original'), hash: '0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5', size: 8, contentType: 'text/markdown', expectedHash: null };
  const pending = await manifest.uploadJournal.prepare([file], 20000);
  manifest.setEntry('Reading/note.md', { hash: file.hash, size: 8, modified: '2026-09-09T00:00:00Z', revision: 'revision' });
  manifest.recordRename('Reading/note.md', file.path);
  await manifest.save(); await manifest.close();
  const journal = h.storage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES);
  await h.move();
  expect(h.settings.workerUrl).toBe(newUrl);
  expect(h.settings.lastSeq).toBe(17);
  expect(h.storage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)).toBe(journal);
  expect(h.storage.forScope(oldUrl).get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)).toBe(journal);
  expect(h.storage.get(SECRET_KEYS.ENCRYPTION_KEYS)).toBe(JSON.stringify(h.bundle));
  expect(h.runtime.getApiClient()).toBeNull();
  expect(h.plugin.app.vault.adapter.remove).not.toHaveBeenCalled();
  expect(h.plugin.app.vault.adapter.write).not.toHaveBeenCalled();
  const restored = normalizeCrateSettings(buildPersistedCrateSettings(h.settings), '.obsidian');
  const reopened = new LocalManifest({ vault: disk.vault } as never, { dir: TEST_PLUGIN_DIR } as never, getCheckpointAuthority(restored));
  await reopened.load();
  expect(reopened.uploadJournal.pending()).toEqual(pending);
  expect(reopened.getEntry('Reading/note.md')?.revision).toBe('revision');
  expect(reopened.renameDestination('Reading/note.md')).toBe(file.path);
  await reopened.close(); h.runtime.destroy();
});

it('retains the original checkpoint identity across successive tunnel changes and clears it on a different connection', async () => {
  const h = await setup();
  await h.move(); await h.move('https://third.trycloudflare.com');
  expect(getCheckpointAuthority(h.settings)).toBe(oldUrl);
  h.settings.workerUrl = 'https://different.example';
  expect(getCheckpointAuthority(h.settings)).toBe(h.settings.workerUrl);
  resetStoredSyncState(h.settings);
  expect(h.settings.checkpointScope).toBeUndefined();
  h.runtime.destroy();
});

it.each(['plaintext', 'different-vault', 'forged-identity'] as const)('rejects %s before copying credentials or changing settings', async kind => {
  const h = await setup();
  const foreign = createVaultKeyBundle();
  const state = createEncryptionState(foreign, await sealRecoveryBundle(foreign, h.recovery));
  h.request.mockResolvedValue({ encryption: kind === 'plaintext' ? null : kind === 'different-vault' ? state : { ...h.state, recovery: state.recovery } });
  await expect(h.move()).rejects.toThrow();
  expect(h.settings.workerUrl).toBe(oldUrl);
  expect(h.storage.forScope(newUrl).get(SECRET_KEYS.AUTH_TOKEN)).toBeNull();
  expect(h.persistSettings).not.toHaveBeenCalled();
});

it.each(['reset', 'folder move', 'vault'] as const)('preserves the destination’s existing %s recovery', async kind => {
  const h = await setup(), target = h.storage.forScope(newUrl);
  const key = kind === 'reset' ? SECRET_KEYS.ENCRYPTION_RESET : kind === 'folder move' ? SECRET_KEYS.ENCRYPTION_FOLDER_MOVES : SECRET_KEYS.ENCRYPTION_KEYS;
  const value = kind === 'vault' ? JSON.stringify(createVaultKeyBundle()) : 'different unfinished recovery';
  target.set(key, value);
  await expect(h.move()).rejects.toThrow();
  expect(h.settings.workerUrl).toBe(oldUrl);
  expect(target.get(key)).toBe(value);
  expect(h.persistSettings).not.toHaveBeenCalled();
});

it.each(['credentials', 'settings'] as const)('retries a failed %s save without losing either recovery copy', async phase => {
  const h = await setup();
  if (phase === 'credentials') h.setSecret.mockImplementationOnce(() => { throw new Error('Save failed'); });
  else h.persistSettings.mockRejectedValueOnce(new Error('Save failed'));
  await expect(h.move()).rejects.toThrow('Save failed');
  expect(h.settings.workerUrl).toBe(oldUrl);
  expect(h.settings.checkpointScope).toBeUndefined();
  expect(readFolderMoves(h.storage).moves[0]?.target).toEqual(h.bundle);
  await h.move();
  expect(h.settings.workerUrl).toBe(newUrl);
  expect(getCheckpointAuthority(h.settings)).toBe(oldUrl);
  h.runtime.destroy();
});

it.each(['shutdown', 'renamed-again'] as const)('fences %s during identity verification', async kind => {
  const h = await setup();
  h.request.mockImplementation(async () => {
    if (kind === 'shutdown') h.controller.abort();
    else writeFolderMoves(h.storage, { version: 1, moves: [{ id: 'new', from: 'Articles', to: 'Later' }] });
    return { encryption: h.state };
  });
  await expect(h.move()).rejects.toThrow();
  expect(h.settings.workerUrl).toBe(oldUrl);
  expect(h.persistSettings).not.toHaveBeenCalled();
  expect(h.storage.forScope(newUrl).get(SECRET_KEYS.AUTH_TOKEN)).toBeNull();
});
