import { openRecoveryBundle } from '../encryption/key-bundle';
import { readFolderMoves } from '../plugin/encryption-folder-move-journal';
import { loadEncryptionKeys } from '../plugin/encryption-storage';
import type { SecretStorageService } from '../plugin/secret-storage';
import { SECRET_KEYS } from '../plugin/settings-types';
import { assertEncryptionKeys, readServerEncryption } from './encryption-conversion';
import type { WorkerApiHttpClient } from './worker-api/http';

/** Verify the encrypted identity before copying connection-scoped secrets.
 * Folder conversion may have advanced local keys before the server accepted it;
 * the authenticated recovery bundle proves identity independently of generation. */
export async function prepareEncryptedAddressChange(storage: SecretStorageService, http: WorkerApiHttpClient, workerUrl: string) {
  if (storage.get(SECRET_KEYS.ENCRYPTION_RESET)) throw new Error('Resume the encryption reset before changing this connection.');
  const keys = loadEncryptionKeys(storage), recovery = storage.get(SECRET_KEYS.ENCRYPTION_RECOVERY);
  if (!keys || !recovery) throw new Error('Recover this device’s encryption keys before changing the server address.');
  readFolderMoves(storage);
  const snapshot = [SECRET_KEYS.AUTH_TOKEN, SECRET_KEYS.ENCRYPTION_KEYS, SECRET_KEYS.ENCRYPTION_RECOVERY, SECRET_KEYS.ENCRYPTION_FOLDER_MOVES]
    .map(key => ({ key, value: storage.get(key) }));
  const assertCurrent = () => {
    if (storage.get(SECRET_KEYS.ENCRYPTION_RESET) || snapshot.some(({ key, value }) => storage.get(key) !== value)) {
      throw new Error('Encryption recovery changed. Retry the server address update.');
    }
  };
  const state = await readServerEncryption(http);
  if (!state) throw new Error('The new address does not identify your encrypted vault');
  const remote = await openRecoveryBundle(state.recovery, recovery);
  assertEncryptionKeys(state, remote);
  if (remote.vaultId !== keys.vaultId || remote.vault.id !== keys.vault.id || remote.vault.secret !== keys.vault.secret) {
    throw new Error('The new address belongs to a different encrypted vault');
  }
  assertCurrent();
  return () => {
    assertCurrent();
    const target = storage.forScope(workerUrl);
    if (target.get(SECRET_KEYS.ENCRYPTION_RESET)) throw new Error('The new address has an unfinished encryption reset');
    const pending = target.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES);
    if (pending && pending !== storage.get(SECRET_KEYS.ENCRYPTION_FOLDER_MOVES)) throw new Error('The new address has a different unfinished folder move');
    const existing = loadEncryptionKeys(target);
    if (existing && (existing.vaultId !== keys.vaultId || existing.vault.id !== keys.vault.id || existing.vault.secret !== keys.vault.secret)) {
      throw new Error('The new address has recovery keys for a different vault');
    }
    // Both copies survive a failed settings save or shutdown. Never migrate or
    // discard file journals: the caller retains their original local authority.
    for (const { key, value } of snapshot) {
      target.set(key, value ?? '');
      if (target.get(key) !== value) throw new Error('Could not verify the moved encryption credentials');
    }
    assertCurrent();
  };
}
