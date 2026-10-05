import { afterEach, expect, it, vi } from 'vitest';
import { TFolder } from 'obsidian';
import type CratePlugin from './CratePlugin';
import { createRuntimeHarness } from '../sync/runtime-test-harness';
import { PersistentTestVault, TEST_PLUGIN_DIR } from '../cloudflare/worker/sync-engine-vault-test-harness';
import { LocalManifest } from '../sync/manifest';
import { WorkerApiHttpClient } from '../sync/worker-api/http';
import { assertRenamePreserved } from '../sync/rename-dependencies';
import { addReminderScope, createVaultKeyBundle, generateRecoveryCode } from '../encryption/key-bundle';
import { saveEncryptionKeys } from './encryption-storage';
import { queueEncryptedFolderMove, resumeEncryptedFolderMoves } from './encryption-folder-moves';
import { computeHash } from '../sync/hasher';

vi.mock('../sync/encryption-conversion', async original => ({ ...await original<object>(), convertEncryptedVault: vi.fn(async () => {}) }));
vi.mock('../reading/runtime', () => ({ startReading: vi.fn(), stopReading: vi.fn(), waitForStoppedReading: vi.fn(async () => {}) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['single', 'rapid', 'previous rename', 'paused rename'] as const)('preserves the remote-deletion guard when encrypted conversion stops the engine (%s)', async mode => {
  const second = mode === 'rapid';
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const h = createRuntimeHarness({ automaticSync: false, syncOnStartup: false, reading: { enabled: true, folderPath: 'Reading' } });
  const disk = new PersistentTestVault();
  for (const folder of ['Reading', 'Articles', 'Saved']) await disk.vault.createFolder(folder);
  disk.write('Reading/note.md', 'private note');
  Object.assign(h.plugin.app, { vault: disk.vault });
  Object.assign(h.plugin.app.workspace, { onLayoutReady: vi.fn() });
  h.plugin.manifest.dir = TEST_PLUGIN_DIR;
  const plugin = Object.assign(h.plugin, {
    settings: h.settings, secretStorage: h.secretStorage, syncRuntime: h.runtime,
    remindersSettings: { enabled: false, remindersFolderPath: 'Reminders' },
    writeSettings: async (patch: object) => { Object.assign(h.settings, patch); },
    writeRemindersSettings: async (update: (settings: object) => object) => { Object.assign(plugin.remindersSettings, update(plugin.remindersSettings)); },
    reinitializeWithFolder: async () => {}, refreshSettingsTab: () => {},
  }) as unknown as CratePlugin;
  const keys = addReminderScope(createVaultKeyBundle(), 'Reading', 'reading');
  saveEncryptionKeys(plugin.secretStorage, keys, await generateRecoveryCode());
  vi.spyOn(WorkerApiHttpClient.prototype, 'getServerInfo').mockResolvedValue({ capabilities: ['e2ee-folder-moves-v1'] } as never);
  const entry = { hash: await computeHash(disk.read('Reading/note.md')), size: 12, modified: '2026-01-01T00:00:00Z', revision: 'source' };
  const seed = new LocalManifest(plugin.app, plugin.manifest, h.settings.workerUrl);
  seed.setEntry('Reading/note.md', entry); await seed.save(); await seed.close();
  await h.runtime.initialize({ skipStartupSync: true });
  let name = 'note.md';
  if (mode === 'previous rename') {
    disk.rename('Reading/note.md', 'Reading/renamed.md'); name = 'renamed.md';
    h.runtime.onFileRename(disk.vault.getAbstractFileByPath('Reading/renamed.md')!, 'Reading/note.md');
  }
  const renamed = (from: string, to: string) => {
    disk.rename(`${from}/${name}`, `${to}/${name}`);
    const folder = Object.assign(new TFolder(), { path: to, children: [disk.vault.getAbstractFileByPath(`${to}/${name}`)] });
    const queued = queueEncryptedFolderMove(plugin, from, to);
    if (!queued) h.runtime.onFileRename(folder, from);
    expect(queued).toBe(true);
  };
  renamed('Reading', 'Articles');
  if (mode === 'paused rename') {
    disk.rename('Articles/note.md', 'Articles/renamed.md'); name = 'renamed.md';
    expect(queueEncryptedFolderMove(plugin, 'Articles/note.md', 'Articles/renamed.md')).toBe(true);
  }
  if (second) renamed('Articles', 'Saved');
  await resumeEncryptedFolderMoves(plugin);
  h.runtime.destroy();
  await new Promise(resolve => setTimeout(resolve, 0));
  const reopened = new LocalManifest(plugin.app, plugin.manifest, h.settings.workerUrl);
  await reopened.load();
  // The destination is still only local: selected deletion of the source must wait.
  await expect(assertRenamePreserved(reopened, disk.vault, 'Reading/note.md')).rejects.toThrow('renamed file is uploaded');
  // Simulate the final destination successfully uploaded during reconciliation.
  const destination = `${second ? 'Saved' : 'Articles'}/${name}`;
  reopened.setEntry(destination, { ...entry, revision: 'uploaded-final' });
  await reopened.save();
  await expect(assertRenamePreserved(reopened, disk.vault, 'Reading/note.md')).resolves.toBeUndefined();
  expect(reopened.renameDestination('Reading/note.md')).toBe(destination);
  await reopened.close();
});
