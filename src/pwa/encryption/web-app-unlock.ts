import { openRecoveryBundle, validateVaultKeyBundle, type VaultKeyBundle } from '../../encryption/key-bundle';
import { assertEncryptionKeys, type EncryptionServerState } from '../../encryption/server-state';
import { rememberVaultKeys } from './encryption-keys';
import { loadStoredConfig } from '../config';
import { READING_SESSION_KEY } from '../reading/storage';
import { capturePwaSession } from '../session-generation';

function connectionGuard(sessionCurrent: () => boolean) {
  const remindersCurrent = capturePwaSession();
  const readingIdentity = localStorage.getItem(READING_SESSION_KEY);
  const remindersFolder = loadStoredConfig().folderPath;
  return () => sessionCurrent() && remindersCurrent()
    && localStorage.getItem(READING_SESSION_KEY) === readingIdentity && loadStoredConfig().folderPath === remindersFolder;
}

async function storeBundle(bundle: VaultKeyBundle, expected: EncryptionServerState, current: () => boolean): Promise<void> {
  if (expected.mode !== 'active') throw new Error('Finish encryption setup in Obsidian before unlocking.');
  if (!current()) throw new Error('The web app connection changed. Retry unlocking.');
  try { assertEncryptionKeys(expected, bundle); } catch { throw new Error('This recovery key does not match the current enrollment'); }
  await rememberVaultKeys(bundle, current);
  if (!current()) throw new Error('The web app connection changed. Retry unlocking.');
}

/** Open the recovery bundle locally and keep its keys as non-extractable CryptoKeys.
 * The recovery code itself is never persisted in the PWA. */
export async function rememberRecoveryKey(code: string, expected: EncryptionServerState, sessionCurrent: () => boolean): Promise<void> {
  const current = connectionGuard(sessionCurrent);
  if (!current()) throw new Error('The web app connection changed. Retry unlocking.');
  await storeBundle(await openRecoveryBundle(expected.recovery, code), expected, current);
}

/** Accept the vault keys from an approved encrypted transfer. */
export async function rememberPairedBundle(payload: unknown, expected: EncryptionServerState, sessionCurrent: () => boolean): Promise<void> {
  const current = connectionGuard(sessionCurrent);
  const packet = payload as { bundle?: unknown } | null;
  if (!packet || typeof packet !== 'object' || Object.keys(packet).join() !== 'bundle') throw new Error('Invalid app key transfer.');
  try { validateVaultKeyBundle(packet.bundle); } catch { throw new Error('Invalid app key transfer.'); }
  await storeBundle(packet.bundle, expected, current);
}
