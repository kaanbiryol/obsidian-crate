import { afterEach, expect, it, vi } from 'vitest';
import { addReminderScope, createVaultKeyBundle, generateRecoveryCode, moveEncryptionScopes, sealRecoveryBundle } from '../encryption/key-bundle';
import { createEncryptionState, ENCRYPTION_FOLDER_MOVES_CAPABILITY } from '../encryption/server-state';
import { saveEncryptionKeys, loadEncryptionKeys } from './encryption-storage';
import { SECRET_KEYS } from './settings-types';
import { queueEncryptedFolderMove, resumeEncryptedFolderMoves, useServerEncryptionFolders } from './encryption-folder-moves';
import type CratePlugin from './CratePlugin';

const mocks = vi.hoisted(() => ({ convert: vi.fn(), info: vi.fn(), state: vi.fn() }));
vi.mock('../sync/encryption-conversion', async importOriginal => ({ ...await importOriginal<object>(), convertEncryptedVault: mocks.convert, readServerEncryption: mocks.state }));
vi.mock('../sync/worker-api/http', () => ({ WorkerApiHttpClient: class { setAbortSignal() {} getServerInfo = mocks.info; } }));
vi.mock('../sync/encryption-rename-checkpoint', () => ({ checkpointEncryptionRenames: vi.fn(async () => {}) }));
vi.mock('../reading/capture-folder-recovery', () => ({ recoverMovedReadingCaptures: vi.fn(async () => {}) }));
vi.mock('../reading/runtime', () => ({ startReading: vi.fn(), stopReading: vi.fn(), waitForStoppedReading: vi.fn(async () => {}) }));
vi.mock('./server-request', () => ({ captureServerConnection: () => ({ origin: 'https://crate.test', token: 'token', signal: new AbortController().signal, assertCurrent: () => {} }) }));
afterEach(() => vi.resetAllMocks());
async function setup() {
  const secrets = new Map<string, string>();
  const keys = addReminderScope(addReminderScope(createVaultKeyBundle(), 'Reminders'), 'Reading', 'reading');
  const plugin = {
    secretStorage: { get: (key: string) => secrets.get(key) || null, set: (key: string, value: string) => secrets.set(key, value) },
    settings: { workerUrl: 'https://crate.test', reading: { enabled: true, folderPath: 'Reading' } },
    remindersSettings: { enabled: true, remindersFolderPath: 'Reminders' },
    syncRuntime: { getRenameDependencies: () => ({}), destroy: vi.fn(), runEncryptionSetup: vi.fn(async (work: () => Promise<void>) => work()), triggerForegroundSync: vi.fn() },
    reinitializeWithFolder: vi.fn(async () => {}), refreshSettingsTab: vi.fn(),
    writeSettings: vi.fn(async (patch: object) => { Object.assign(plugin.settings, patch); }),
    writeRemindersSettings: vi.fn(async (update: (current: typeof plugin.remindersSettings) => object) => { Object.assign(plugin.remindersSettings, update(plugin.remindersSettings)); }),
  };
  const real = plugin as unknown as CratePlugin;
  saveEncryptionKeys(real.secretStorage, keys, await generateRecoveryCode());
  mocks.info.mockResolvedValue({ capabilities: [ENCRYPTION_FOLDER_MOVES_CAPABILITY] });
  mocks.convert.mockResolvedValue(undefined);
  return { plugin: real, secrets, keys, fake: plugin };
}
it('preserves ordered offline moves and applies them after reconnecting', async () => {
  const h = await setup();
  expect(queueEncryptedFolderMove(h.plugin, 'Reminders', 'Tasks')).toBe(true);
  mocks.info.mockRejectedValueOnce(new Error('offline'));
  await expect(resumeEncryptedFolderMoves(h.plugin)).rejects.toThrow('offline');
  expect(loadEncryptionKeys(h.plugin.secretStorage)).toEqual(h.keys);
  expect(queueEncryptedFolderMove(h.plugin, 'Tasks', 'Personal/Tasks')).toBe(true);
  await resumeEncryptedFolderMoves(h.plugin);
  expect(loadEncryptionKeys(h.plugin.secretStorage)?.scopes[0]?.folderPath).toBe('Personal/Tasks');
  expect(h.plugin.remindersSettings.remindersFolderPath).toBe('Personal/Tasks');
  expect(h.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)).toBeNull();
  expect(mocks.convert).toHaveBeenCalledTimes(2);
});
it('gives a folder selection a new access identity and keeps it across later renames', async () => {
  const h = await setup();
  queueEncryptedFolderMove(h.plugin, 'Reading', 'Articles', false);
  mocks.convert.mockRejectedValueOnce(new Error('lost reply'));
  await expect(resumeEncryptedFolderMoves(h.plugin)).rejects.toThrow('lost reply');
  const selected = loadEncryptionKeys(h.plugin.secretStorage)!.scopes[1]!;
  expect(selected.accessId).toBeTruthy();
  expect(selected.data).toEqual(h.keys.scopes[1]!.data);
  await resumeEncryptedFolderMoves(h.plugin);
  queueEncryptedFolderMove(h.plugin, 'Articles', 'Saved/Articles');
  await resumeEncryptedFolderMoves(h.plugin);
  expect(loadEncryptionKeys(h.plugin.secretStorage)!.scopes[1]!.accessId).toBe(selected.accessId);
});
it('retries the same target after a lost conversion reply and a failed settings save', async () => {
  const h = await setup(); queueEncryptedFolderMove(h.plugin, 'Reading', 'Articles');
  mocks.convert.mockRejectedValueOnce(new Error('lost reply'));
  await expect(resumeEncryptedFolderMoves(h.plugin)).rejects.toThrow('lost reply');
  const target = loadEncryptionKeys(h.plugin.secretStorage);
  h.fake.writeSettings.mockRejectedValueOnce(new Error('disk full'));
  await expect(resumeEncryptedFolderMoves(h.plugin)).rejects.toThrow('disk full');
  await resumeEncryptedFolderMoves(h.plugin);
  expect(mocks.convert.mock.calls.map(call => call[1] as unknown)).toEqual([target, target, target]);
  expect(h.plugin.settings.reading.folderPath).toBe('Articles');
  expect(h.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)).toBeNull();
});
it('does not append a nested destination twice when the first settings save already succeeded', async () => {
  const h = await setup(); queueEncryptedFolderMove(h.plugin, 'Reading', 'Reading/Archive');
  h.fake.writeRemindersSettings.mockRejectedValueOnce(new Error('disk full'));
  await expect(resumeEncryptedFolderMoves(h.plugin)).rejects.toThrow('disk full');
  expect(h.plugin.settings.reading.folderPath).toBe('Reading/Archive');
  await resumeEncryptedFolderMoves(h.plugin);
  expect(h.plugin.settings.reading.folderPath).toBe('Reading/Archive');
  expect(loadEncryptionKeys(h.plugin.secretStorage)?.scopes[1]?.folderPath).toBe('Reading/Archive');
});
it('resumes older folder checkpoints that already saved a nested setting', async () => {
  const h = await setup(); queueEncryptedFolderMove(h.plugin, 'Reading', 'Reading/Archive');
  h.fake.writeRemindersSettings.mockRejectedValueOnce(new Error('disk full'));
  await expect(resumeEncryptedFolderMoves(h.plugin)).rejects.toThrow('disk full');
  const saved = JSON.parse(h.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)!) as { moves: Array<{ settings?: unknown }> };
  delete saved.moves[0]!.settings;
  h.plugin.secretStorage.set(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES, JSON.stringify(saved));
  await resumeEncryptedFolderMoves(h.plugin);
  expect(h.plugin.settings.reading.folderPath).toBe('Reading/Archive');
});

it('keeps an interrupted mapping when the user selected a different local folder', async () => {
  const h = await setup(); queueEncryptedFolderMove(h.plugin, 'Reading', 'Articles');
  mocks.convert.mockRejectedValueOnce(new Error('offline'));
  await expect(resumeEncryptedFolderMoves(h.plugin)).rejects.toThrow('offline');
  h.plugin.settings.reading.folderPath = 'New selection';
  await expect(resumeEncryptedFolderMoves(h.plugin)).rejects.toThrow('Folder settings changed');
  expect(h.plugin.settings.reading.folderPath).toBe('New selection');
  expect(h.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)).not.toBeNull();
});
it('refuses a saved target belonging to a different vault before replacing this device’s keys', async () => {
  const h = await setup(); queueEncryptedFolderMove(h.plugin, 'Reading', 'Articles');
  const saved = JSON.parse(h.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)!) as { moves: Array<{ target?: unknown }> };
  saved.moves[0]!.target = addReminderScope(createVaultKeyBundle(), 'Articles', 'reading');
  h.plugin.secretStorage.set(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES, JSON.stringify(saved));
  await expect(resumeEncryptedFolderMoves(h.plugin)).rejects.toThrow();
  expect(loadEncryptionKeys(h.plugin.secretStorage)).toEqual(h.keys);
  expect(mocks.convert).not.toHaveBeenCalled();
});
it('does not change keys on unsupported servers and does not journal ordinary file renames', async () => {
  const h = await setup();
  expect(queueEncryptedFolderMove(h.plugin, 'Reminders/Note.md', 'Reminders/Renamed.md')).toBe(false);
  expect(h.fake.syncRuntime.destroy).not.toHaveBeenCalled();
  queueEncryptedFolderMove(h.plugin, 'Reading', 'Articles');
  mocks.info.mockResolvedValue({ capabilities: [] });
  await expect(resumeEncryptedFolderMoves(h.plugin)).rejects.toThrow('Update your Crate server');
  expect(loadEncryptionKeys(h.plugin.secretStorage)).toEqual(h.keys);
  expect(mocks.convert).not.toHaveBeenCalled();
  expect(h.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)).not.toBeNull();
});

it.each(['initialization', 'reminders'])('drains a rename arriving during %s before resolving', async phase => {
  const h = await setup(); queueEncryptedFolderMove(h.plugin, 'Reading', 'Articles');
  const append = () => { queueEncryptedFolderMove(h.plugin, 'Articles', 'Saved/Articles'); };
  if (phase === 'initialization') h.fake.syncRuntime.runEncryptionSetup.mockImplementationOnce(async work => { await work(); append(); });
  else h.fake.reinitializeWithFolder.mockImplementationOnce(async () => { append(); });
  await resumeEncryptedFolderMoves(h.plugin);
  expect(loadEncryptionKeys(h.plugin.secretStorage)?.scopes[1]?.folderPath).toBe('Saved/Articles');
  expect(h.plugin.settings.reading.folderPath).toBe('Saved/Articles');
  expect(h.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)).toBeNull();
});

it('recovers conflicting device mappings through the authenticated server bundle without moving local files', async () => {
  const h = await setup(); queueEncryptedFolderMove(h.plugin, 'Reminders', 'Tasks');
  mocks.convert.mockRejectedValueOnce(new Error('Another device changed folders'));
  await expect(resumeEncryptedFolderMoves(h.plugin)).rejects.toThrow('Another device');
  const remote = moveEncryptionScopes(h.keys, 'Reminders', 'Todos');
  const recovery = h.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_RECOVERY)!;
  mocks.state.mockResolvedValue({ ...createEncryptionState(remote, await sealRecoveryBundle(remote, recovery)), mode: 'active' });
  h.fake.writeRemindersSettings.mockRejectedValueOnce(new Error('disk full'));
  await expect(useServerEncryptionFolders(h.plugin)).rejects.toThrow('disk full');
  expect(h.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)).not.toBeNull();
  await useServerEncryptionFolders(h.plugin);
  expect(loadEncryptionKeys(h.plugin.secretStorage)).toEqual(remote);
  expect(h.plugin.remindersSettings.remindersFolderPath).toBe('Todos');
  expect(h.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)).toBeNull();
});

it('preserves the move checkpoint when server recovery cannot authenticate', async () => {
  const h = await setup(); queueEncryptedFolderMove(h.plugin, 'Reading', 'Articles');
  const snapshot = h.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES);
  mocks.state.mockResolvedValue({ ...createEncryptionState(h.keys, await sealRecoveryBundle(h.keys, await generateRecoveryCode())), mode: 'active' });
  await expect(useServerEncryptionFolders(h.plugin)).rejects.toThrow();
  expect(h.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)).toBe(snapshot);
  expect(loadEncryptionKeys(h.plugin.secretStorage)).toEqual(h.keys);
  expect(h.fake.writeSettings).not.toHaveBeenCalled();
});
