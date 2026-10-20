import type CratePlugin from './CratePlugin';
import { loadEncryptionKeys, saveEncryptionKeys } from '../sync/encryption/key-storage';
import { captureServerConnection } from './server-request';
import { moveEncryptionScopes, openRecoveryBundle } from '../encryption/key-bundle';
import { WorkerApiHttpClient } from '../sync/worker-api/http';
import { assertEncryptionKeys, convertEncryptedVault, readServerEncryption } from '../sync/encryption/conversion';
import { startReading, stopReading, waitForStoppedReading } from '../reading/runtime';
import { checkpointEncryptionRenames } from '../sync/encryption/rename-checkpoint';
import { folderMoveTarget, movedPath, readFolderMoves, writeFolderMoves } from '../sync/encryption/folder-move-journal';
import { applyNextEncryptedFolderMove } from './encryption-folder-move-workflow';
import { SECRET_KEYS } from '../platform/secret-keys';

const running = new WeakMap<CratePlugin, Promise<void>>();

// Loaded on demand so sync modules that import this one do not load the reminders UI.
async function restartReminders(plugin: CratePlugin): Promise<void> {
  if (!plugin.remindersSettings.enabled) return;
  const { reinitializeWithFolder } = await import('../reminders/plugin-integration');
  await reinitializeWithFolder(plugin, plugin.remindersSettings.remindersFolderPath);
}

/** Persist before stopping sync or attempting the network. Rapid/offline renames
 * keep their order, and an uncertain conversion retains its exact next bundle. */
export function queueEncryptedFolderMove(plugin: CratePlugin, from: string, to: string, rename = true): boolean {
  let keys = loadEncryptionKeys(plugin.secretStorage);
  if (!keys || !plugin.settings.workerUrl || from === to) return false;
  if (plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_RESET)) throw new Error('Resume the encryption reset before changing encrypted folders.');
  const saved = readFolderMoves(plugin.secretStorage);
  for (const move of saved.moves) keys = folderMoveTarget(keys, move);
  const scopeChange = moveEncryptionScopes(keys, from, to) !== keys;
  if (!scopeChange && (!rename || !saved.moves.length)) return false;
  if (saved.moves.length >= 128) throw new Error('Reconnect to finish pending encrypted folder moves before moving another folder.');
  const priorRenames = saved.moves.length ? undefined : plugin.syncRuntime.getRenameDependencies();
  writeFolderMoves(plugin.secretStorage, { version: 1, moves: [...saved.moves, { id: crypto.randomUUID(), from, to, rename, scopeChange, priorRenames }] });
  plugin.syncRuntime.destroy();
  stopReading(plugin);
  return true;
}

export async function changeEncryptedFolder(plugin: CratePlugin, from: string, to: string): Promise<boolean> {
  if (!queueEncryptedFolderMove(plugin, from, to, false)) return false;
  await resumeEncryptedFolderMoves(plugin);
  return true;
}

export function resumeEncryptedFolderMoves(plugin: CratePlugin, progress: (message: string) => void = () => {}): Promise<void> {
  const existing = running.get(plugin);
  if (existing) return existing;
  if (!plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)) return Promise.resolve();
  const connection = captureServerConnection(plugin);
  const task = Promise.resolve().then(async () => {
  do { await plugin.syncRuntime.runEncryptionSetup(async () => {
    connection.assertCurrent(); stopReading(plugin);
    await waitForStoppedReading(plugin); connection.assertCurrent();
    const http = new WorkerApiHttpClient(connection.origin, connection.token ?? '');
    http.setAbortSignal(connection.signal);
    while (await applyNextEncryptedFolderMove({
      storage: plugin.secretStorage, origin: connection.origin, assertCurrent: connection.assertCurrent,
      checkpointRenames: () => checkpointEncryptionRenames(plugin),
      convertVault: (target, recovery) => convertEncryptedVault(http, target, recovery, progress),
      getReadingSettings: () => plugin.settings.reading,
      getRemindersFolderPath: () => plugin.remindersSettings.remindersFolderPath,
      writeReadingSettings: (reading, assertCurrent) => plugin.writeSettings({ reading }, assertCurrent),
      writeRemindersSettings: (update, assertCurrent) => plugin.writeRemindersSettings(update, assertCurrent),
    })) { /* Drain all persisted moves before restarting the runtimes. */ }
  }); } while (plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES));
    connection.assertCurrent();
    await restartReminders(plugin);
    connection.assertCurrent();
    // A rename can arrive while reminders are restarting. Release this task
    // before recursing so callers wait for every persisted move to finish.
    if (plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)) {
      if (running.get(plugin) === task) running.delete(plugin);
      await resumeEncryptedFolderMoves(plugin, progress);
      return;
    }
    startReading(plugin); plugin.refreshSettingsTab(); plugin.syncRuntime.triggerForegroundSync('focus');
  }).finally(() => { if (running.get(plugin) === task) running.delete(plugin); });
  running.set(plugin, task);
  return task;
}

/** Explicit conflict recovery adopts an authenticated, completed server bundle.
 * Only the pending scope mapping is dropped; local files/rename journals stay. */
export async function useServerEncryptionFolders(plugin: CratePlugin): Promise<void> {
  if (running.has(plugin)) throw new Error('Wait for the current folder move to finish before using server settings.');
  const connection = captureServerConnection(plugin);
  const snapshot = plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES);
  if (!snapshot) return;
  const assertCurrent = () => {
    connection.assertCurrent();
    if (plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES) !== snapshot) throw new Error('Another folder moved. Reopen Manage encryption.');
  };
  await plugin.syncRuntime.runEncryptionSetup(async () => {
    assertCurrent(); stopReading(plugin);
    await waitForStoppedReading(plugin); assertCurrent();
    await checkpointEncryptionRenames(plugin); assertCurrent();
    const http = new WorkerApiHttpClient(connection.origin, connection.token ?? ''); http.setAbortSignal(connection.signal);
    const state = await readServerEncryption(http);
    if (!state || state.mode !== 'active') throw new Error('Finish conversion on the device that started it before using server folder settings.');
    const recovery = plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_RECOVERY);
    if (!recovery) throw new Error('This device needs its saved recovery key to use server folder settings.');
    const bundle = await openRecoveryBundle(state.recovery, recovery); assertEncryptionKeys(state, bundle);
    const local = loadEncryptionKeys(plugin.secretStorage);
    if (!local || local.vaultId !== bundle.vaultId) throw new Error('The server belongs to a different encrypted vault.');
    // The current settings may still use a pre-conversion path after a failed
    // settings save, so also match the original path through queued jobs.
    const mapFolder = (path: string, purpose: 'reading' | 'reminders') => {
      const jobs = readFolderMoves(plugin.secretStorage).moves, paths = [path];
      for (const move of jobs) paths.push(movedPath(paths[paths.length - 1]!, move.from, move.to));
      const scope = [local, ...jobs.flatMap(job => job.target ? [job.target] : [])].flatMap(keys => keys.scopes)
        .find(scope => paths.includes(scope.folderPath) && (scope.purpose ?? 'reminders') === purpose);
      return (scope && bundle.scopes.find(next => next.id === scope.id)?.folderPath) ?? path;
    };
    assertCurrent();
    const reading = plugin.settings.reading;
    await plugin.writeSettings({ reading: { ...reading, folderPath: mapFolder(reading.folderPath, 'reading') } }, assertCurrent);
    await plugin.writeRemindersSettings(current => ({ remindersFolderPath: mapFolder(current.remindersFolderPath, 'reminders'), pendingServerFolder: undefined }), assertCurrent);
    assertCurrent(); saveEncryptionKeys(plugin.secretStorage, bundle, recovery);
    assertCurrent();
    writeFolderMoves(plugin.secretStorage, { version: 1, moves: [] });
  });
  connection.assertCurrent();
  await restartReminders(plugin);
  connection.assertCurrent(); startReading(plugin); plugin.refreshSettingsTab(); plugin.syncRuntime.triggerForegroundSync('focus');
}
