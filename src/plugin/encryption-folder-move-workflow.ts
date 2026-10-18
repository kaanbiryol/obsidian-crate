import type { VaultKeyBundle } from '../encryption/key-bundle';
import type { ReadingSettings } from '../reading/settings';
import type { RemindersSettings } from '../reminders/settings';
import type { SecretStorageService } from './secret-storage';
import { loadEncryptionKeys, saveEncryptionKeys } from './encryption-storage';
import { SECRET_KEYS } from './settings-types';
import {
  applyFolderSetting,
  completeFolderMoveHead,
  folderMoveSettings,
  folderMoveTarget,
  readFolderMoves,
  replaceFolderMoveHead,
} from './encryption-folder-move-journal';

interface FolderMoveWorkflowContext {
  storage: SecretStorageService;
  origin: string;
  assertCurrent: () => void;
  checkpointRenames(): Promise<void>;
  convertVault(target: VaultKeyBundle, recovery: string): Promise<void>;
  getReadingSettings(): ReadingSettings;
  getRemindersFolderPath(): string;
  writeReadingSettings(settings: ReadingSettings, assertCurrent: () => void): Promise<void>;
  writeRemindersSettings(update: (current: RemindersSettings) => Partial<RemindersSettings>, assertCurrent: () => void): Promise<void>;
}

/** Apply one persisted job; retain it until conversion and both settings saves finish. */
export async function applyNextEncryptedFolderMove(context: FolderMoveWorkflowContext): Promise<boolean> {
  context.assertCurrent();
  const job = readFolderMoves(context.storage).moves[0];
  if (!job) return false;
  await context.checkpointRenames();
  context.assertCurrent();
  if (job.scopeChange === false) {
    completeFolderMoveHead(context.storage, job.id);
    return true;
  }

  const keys = loadEncryptionKeys(context.storage), recovery = context.storage.get(SECRET_KEYS.ENCRYPTION_RECOVERY);
  if (!keys || !recovery) throw new Error('Unlock this vault with its recovery key before resuming the folder move.');
  const target = folderMoveTarget(keys, job);
  if (!job.target || !job.settings) {
    job.target = target;
    job.settings ??= folderMoveSettings(job, target, context.getReadingSettings().folderPath, context.getRemindersFolderPath());
    replaceFolderMoveHead(context.storage, job);
  }
  context.assertCurrent(); saveEncryptionKeys(context.storage, target, recovery);
  await context.convertVault(target, recovery);
  context.assertCurrent();

  // Each setting save is idempotent. Keep the journal until both succeeded.
  const reading = context.getReadingSettings();
  await context.writeReadingSettings({ ...reading, folderPath: applyFolderSetting(reading.folderPath, job.settings.reading) }, () => {
    context.assertCurrent();
    const current = context.getReadingSettings();
    if (current.folderPath !== reading.folderPath || current.enabled !== reading.enabled) throw new Error('Reading settings changed. Resume the saved folder move.');
  });
  await context.writeRemindersSettings(current => ({
    remindersFolderPath: applyFolderSetting(current.remindersFolderPath, job.settings!.reminders),
    ...(current.pendingServerFolder?.workerUrl === context.origin ? { pendingServerFolder: undefined } : {}),
  }), context.assertCurrent);
  context.assertCurrent();
  completeFolderMoveHead(context.storage, job.id);
  return true;
}
