import { rememberEncryptionUnlock } from '../../encryption/encryption-onboarding';
import { onReadingEncryptionReset } from './encryption-lifecycle';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol/server-info';
import { ENCRYPTION_GENERATION_HEADER, ENCRYPTION_VAULT_HEADER } from '@/encryption/server-state';
import { loadEncryptionState, loadVaultKeys, assertEncryptionActive, EncryptionVerificationUnavailableError } from '../../connection/encryption';
import type { EncryptionServerState } from '@/encryption/server-state';
import { unlockLocalState, type FeatureKeys } from '../../encryption/encryption-keys';
import { pendingReadingKey, forgetReadingKey } from '../../encryption/encryption-fragments';
import { abortTransaction } from '../../storage/abort-transaction';
import { lockReadingStorage, unlockReadingStorage, encodeReadingValue } from '../storage/private-storage';
import { assertReadingSession, type ReadingSession } from './session';
import { readingDatabase } from '../storage/database';
import { isSessionReadingKey } from '@/pwa/reading/storage/storage-keys';
import { rememberRecoveryKey } from '../../encryption/web-app-unlock';

let pending: { identity: string; promise: Promise<FeatureKeys | null> } | undefined;
let currentKeys: FeatureKeys | null = null;
let expected: EncryptionServerState | null = null;
let verifiedIdentity: string | undefined;
onReadingEncryptionReset(discardKeys => {
  pending = undefined; currentKeys = null; expected = null; verifiedIdentity = undefined;
  if (discardKeys) forgetReadingKey();
  lockReadingStorage();
});
export function readingEncryptionHeaders(): Record<string, string> {
  return expected ? { [ENCRYPTION_VAULT_HEADER]: expected.vaultId, [ENCRYPTION_GENERATION_HEADER]: String(expected.generation) } : {};
}
/** `beforePlaintextBody` verifies a cached plaintext verdict again before a request
 * sends plaintext. Reads reuse it: the server answers 428 once encryption is on. */
export function prepareReadingEncryption(session: ReadingSession, refresh = false, beforePlaintextBody = false): Promise<FeatureKeys | null> {
  assertReadingSession(session);
  const identity = JSON.stringify([session.token, session.id, session.generation, session.folderPath]);
  if (refresh || beforePlaintextBody && !currentKeys && verifiedIdentity === identity) pending = undefined;
  if (pending?.identity === identity) return pending.promise;
  const current = () => { try { assertReadingSession(session); return pending?.promise === work; } catch { return false; } };
  const work = (async () => {
    const verified = await loadEncryptionState({ token: session.token, purpose: 'reading', fragment: pendingReadingKey(), current,
      request: () => fetch('/reading/encryption', { cache: 'no-store', signal: AbortSignal.timeout(20_000), headers: { Authorization: `Bearer ${session.token}`, [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current) } }) });
    const state = verified?.state ?? null;
    expected = state;
    if (!state) { verifiedIdentity = identity; currentKeys = null; lockReadingStorage(false); return null; }
    if (!currentKeys) lockReadingStorage();
    assertEncryptionActive(state);
    const keys = await loadVaultKeys(verified!, session.folderPath, current, pendingReadingKey());
    forgetReadingKey();
    const local = await unlockLocalState(keys, 'reading');
    if (!current()) { local.destroy(); throw new Error('Reading sign-in changed.'); }
    unlockReadingStorage(local);
    // All this session's plaintext records migrate atomically before hydration. Never
    // reinterpret another session's unreadable records or silently discard them.
    const db = await readingDatabase();
    if (!current()) throw new Error('Reading sign-in changed.');
    const tx = db.transaction('values', 'readwrite');
    try {
      for (const key of await tx.store.getAllKeys()) if (isSessionReadingKey(key, session.id)) {
        const value = await tx.store.get(key);
        if (!(value && typeof value === 'object' && 'encryptedReading' in value)) await tx.store.put(encodeReadingValue(key, value), key);
      }
      if (!current()) throw new Error('Reading sign-in changed.');
      await tx.done;
    } catch (error) { await abortTransaction(tx); throw error; }
    if (!current()) throw new Error('Reading sign-in changed.');
    rememberEncryptionUnlock(state.vaultId);
    verifiedIdentity = identity;
    currentKeys = keys;
    return currentKeys;
  })().catch(error => {
    if (current()) {
      // An unanswered check (network or server error) must not revoke this
      // session's verified local access.
      // The request still fails, so no unverified plaintext reaches the server.
      // Reminders deliberately lock instead (see reminders/encryption-session.ts).
      if (!(error instanceof EncryptionVerificationUnavailableError) || verifiedIdentity !== identity) {
        lockReadingStorage(true, error instanceof Error ? error.message : undefined);
        currentKeys = null; verifiedIdentity = undefined;
      }
      pending = undefined;
    }
    throw error;
  });
  pending = { identity, promise: work };
  return work;
}
export async function unlockReadingWithCode(code: string, session: ReadingSession): Promise<void> {
  if (!expected) throw new Error('Verify the Reading connection first.');
  const state = expected;
  await rememberRecoveryKey(code, state, () => { try { assertReadingSession(session); return expected === state; } catch { return false; } });
  location.reload();
}
export function readingKeys(): FeatureKeys | null { return currentKeys; }
