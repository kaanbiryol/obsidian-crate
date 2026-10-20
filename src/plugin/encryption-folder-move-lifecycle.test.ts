import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CratePlugin from './CratePlugin';
import { SecretStorageService } from './secret-storage';
import { normalizeCrateSettings } from './settings';
import { endPluginLifecycle } from './lifecycle-state';
import { saveEncryptionKeys } from '../sync/encryption/key-storage';
import { queueEncryptedFolderMove, resumeEncryptedFolderMoves } from './encryption-folder-moves';
import { DEFAULT_REMINDERS_SETTINGS, useRemindersSettingsStore } from '../reminders/settings';
import { addReminderScope, createVaultKeyBundle, generateRecoveryCode } from '../encryption/key-bundle';
import { SyncRuntime } from '../sync/runtime/runtime';
import { WorkerApiHttpClient } from '../sync/worker-api/http';
import { convertEncryptedVault } from '../sync/encryption/conversion';
import { startReading } from '../reading/runtime';
import { reinitializeWithFolder } from '../reminders/plugin-integration';
import { SECRET_KEYS } from '../platform/secret-keys';

vi.mock('./lifecycle', () => ({ bootstrapPlugin: vi.fn(), shutdownPlugin: vi.fn() }));
vi.mock('../reminders/plugin-integration', () => ({ reinitializeWithFolder: vi.fn() }));
vi.mock('../reading/runtime', () => ({ startReading: vi.fn(), stopReading: vi.fn(), waitForStoppedReading: vi.fn(async () => {}) }));
vi.mock('../sync/encryption/rename-checkpoint', () => ({ checkpointEncryptionRenames: vi.fn(async () => {}) }));
vi.mock('../sync/encryption/conversion', async original => ({ ...await original<object>(), convertEncryptedVault: vi.fn(async () => {}) }));

beforeEach(() => {
  vi.clearAllMocks();
  useRemindersSettingsStore.setState({ ...DEFAULT_REMINDERS_SETTINGS, enabled: true, remindersFolderPath: 'Notes/Reminders' }, true);
});
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const plugin = new CratePlugin({} as never, {} as never);
  const secrets = new Map<string, string>();
  const saveData = vi.fn<(value: unknown) => Promise<void>>(async () => {});
  Object.assign(plugin, {
    app: {
      vault: { configDir: '.obsidian' },
      secretStorage: { getSecret: (key: string) => secrets.get(key) ?? '', setSecret: (key: string, value: string) => { secrets.set(key, value); } },
    },
    settings: normalizeCrateSettings({ workerUrl: 'https://crate.test', reading: { enabled: true, folderPath: 'Notes/Reading' } }, '.obsidian'),
    saveData,
  });
  plugin.secretStorage = new SecretStorageService(plugin.app, () => plugin.settings.workerUrl);
  plugin.secretStorage.set(SECRET_KEYS.AUTH_TOKEN, 'original-token');
  const keys = addReminderScope(addReminderScope(createVaultKeyBundle(), 'Notes/Reminders'), 'Notes/Reading', 'reading');
  saveEncryptionKeys(plugin.secretStorage, keys, await generateRecoveryCode());
  plugin.syncRuntime = new SyncRuntime(plugin, plugin.settings, plugin.secretStorage, () => plugin.saveSettings());
  const initialize = vi.spyOn(plugin.syncRuntime, 'initialize').mockResolvedValue();
  const reinitialize = vi.mocked(reinitializeWithFolder).mockResolvedValue();
  const refresh = vi.spyOn(plugin, 'refreshSettingsTab');
  vi.spyOn(WorkerApiHttpClient.prototype, 'getServerInfo').mockResolvedValue({ capabilities: ['e2ee-folder-moves-v1'] } as never);
  queueEncryptedFolderMove(plugin, 'Notes', 'Archive');
  return { plugin, saveData, initialize, reinitialize, refresh };
}

it.each([
  ['conversion', 'token'], ['conversion', 'unload'],
  ['reading save', 'token'], ['reading save', 'unload'],
  ['reminders save', 'token'], ['reminders save', 'unload'],
] as const)('retains recovery without publishing or restarting when %s is interrupted by %s', async (phase, invalidation) => {
  const f = await fixture();
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  if (phase === 'conversion') vi.mocked(convertEncryptedVault).mockImplementationOnce(() => paused);
  else {
    const pauseSave = phase === 'reading save' ? 1 : 2;
    f.saveData.mockImplementation(async () => { if (f.saveData.mock.calls.length === pauseSave) await paused; });
  }
  const pending = resumeEncryptedFolderMoves(f.plugin);
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => phase === 'conversion'
    ? expect(convertEncryptedVault).toHaveBeenCalledOnce()
    : expect(f.saveData).toHaveBeenCalledTimes(phase === 'reading save' ? 1 : 2));
  const journal = f.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES);
  const keys = f.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_KEYS);
  const settingsBefore = structuredClone({ reading: f.plugin.settings.reading, reminders: f.plugin.remindersSettings });
  if (invalidation === 'token') f.plugin.secretStorage.set(SECRET_KEYS.AUTH_TOKEN, 'replacement-token');
  else { endPluginLifecycle(f.plugin); f.plugin.syncRuntime.destroy(); }
  release();
  await rejected;

  expect(journal).not.toBeNull();
  expect(f.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)).toBe(journal);
  expect(f.plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_KEYS)).toBe(keys);
  expect({ reading: f.plugin.settings.reading, reminders: f.plugin.remindersSettings }).toEqual(settingsBefore);
  expect(f.saveData).toHaveBeenCalledTimes(phase === 'conversion' ? 0 : phase === 'reading save' ? 1 : 2);
  expect(f.initialize).not.toHaveBeenCalled();
  expect(f.reinitialize).not.toHaveBeenCalled();
  expect(startReading).not.toHaveBeenCalled();
  expect(f.refresh).not.toHaveBeenCalled();
  f.plugin.syncRuntime.destroy();
});
