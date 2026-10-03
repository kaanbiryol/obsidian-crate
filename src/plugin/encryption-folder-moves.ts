import type CratePlugin from './CratePlugin';
import { loadEncryptionKeys, saveEncryptionKeys } from './encryption-storage';
import { SECRET_KEYS } from './settings-types';
import { captureServerConnection } from './server-request';
import { moveEncryptionScopes, openRecoveryBundle } from '../encryption/key-bundle';
import { ENCRYPTION_FOLDER_MOVES_CAPABILITY } from '../encryption/server-state';
import { WorkerApiHttpClient } from '../sync/worker-api/http';
import { assertEncryptionKeys, convertEncryptedVault, readServerEncryption } from '../sync/encryption-conversion';
import { startReading, stopReading, waitForStoppedReading } from '../reading/runtime';
import { checkpointEncryptionRenames } from '../sync/encryption-rename-checkpoint';
import { recoverMovedReadingCaptures } from '../reading/capture-folder-recovery';
import { applyFolderSetting, folderMoveSettings, folderMoveTarget, movedPath, readFolderMoves, writeFolderMoves } from './encryption-folder-move-journal';

const running = new WeakMap<CratePlugin, Promise<void>>();

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
    if (!(await http.getServerInfo()).capabilities.includes(ENCRYPTION_FOLDER_MOVES_CAPABILITY)) throw new Error('Update your Crate server before moving encrypted folders.');
    for (;;) {
      connection.assertCurrent();
      const job = readFolderMoves(plugin.secretStorage).moves[0];
      if (!job) break;
      await checkpointEncryptionRenames(plugin);
      connection.assertCurrent();
      if (job.scopeChange === false) {
        if (readFolderMoves(plugin.secretStorage).moves.length === 1) await recoverMovedReadingCaptures(plugin);
        const latest = readFolderMoves(plugin.secretStorage);
        if (latest.moves[0]?.id !== job.id) throw new Error('The pending folder move changed. Reopen Manage encryption.');
        writeFolderMoves(plugin.secretStorage, { ...latest, moves: latest.moves.slice(1) });
        continue;
      }
      const keys = loadEncryptionKeys(plugin.secretStorage), recovery = plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_RECOVERY);
      if (!keys || !recovery) throw new Error('Unlock this vault with its recovery key before resuming the folder move.');
      const target = folderMoveTarget(keys, job);
      if (!job.target || !job.settings) {
        job.target = target;
        job.settings ??= folderMoveSettings(job, target, plugin.settings.reading.folderPath, plugin.remindersSettings.remindersFolderPath);
        const latest = readFolderMoves(plugin.secretStorage);
        if (latest.moves[0]?.id !== job.id) throw new Error('The pending folder move changed. Reopen Manage encryption.');
        writeFolderMoves(plugin.secretStorage, { ...latest, moves: [job, ...latest.moves.slice(1)] });
      }
      connection.assertCurrent(); saveEncryptionKeys(plugin.secretStorage, target, recovery);
      await convertEncryptedVault(http, target, recovery, progress);
      connection.assertCurrent();
      // Each setting save is idempotent. Keep the journal until both succeeded.
      const reading = plugin.settings.reading;
      await plugin.writeSettings({ reading: { ...reading, folderPath: applyFolderSetting(reading.folderPath, job.settings.reading) } }, () => {
        connection.assertCurrent();
        if (plugin.settings.reading.folderPath !== reading.folderPath || plugin.settings.reading.enabled !== reading.enabled) throw new Error('Reading settings changed. Resume the saved folder move.');
      });
      await plugin.writeRemindersSettings(current => ({
        remindersFolderPath: applyFolderSetting(current.remindersFolderPath, job.settings!.reminders),
        ...(current.pendingServerFolder?.workerUrl === connection.origin ? { pendingServerFolder: undefined } : {}),
      }), connection.assertCurrent);
      connection.assertCurrent();
      if (readFolderMoves(plugin.secretStorage).moves.length === 1) await recoverMovedReadingCaptures(plugin);
      const latest = readFolderMoves(plugin.secretStorage);
      if (latest.moves[0]?.id !== job.id) throw new Error('The pending folder move changed. Reopen Manage encryption.');
      writeFolderMoves(plugin.secretStorage, { ...latest, moves: latest.moves.slice(1) });
    }
  }); } while (plugin.secretStorage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES));
    connection.assertCurrent();
    if (plugin.remindersSettings.enabled) await plugin.reinitializeWithFolder(plugin.remindersSettings.remindersFolderPath);
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
    await recoverMovedReadingCaptures(plugin); assertCurrent();
    writeFolderMoves(plugin.secretStorage, { version: 1, moves: [] });
  });
  connection.assertCurrent();
  if (plugin.remindersSettings.enabled) await plugin.reinitializeWithFolder(plugin.remindersSettings.remindersFolderPath);
  connection.assertCurrent(); startReading(plugin); plugin.refreshSettingsTab(); plugin.syncRuntime.triggerForegroundSync('focus');
}
