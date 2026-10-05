import { rememberEncryptionUnlock } from '../encryption-onboarding';
import { onReadingEncryptionReset } from './encryption-lifecycle';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol';
import { loadEncryptionState, loadScopeKeys, assertEncryptionActive, EncryptionVerificationUnavailableError } from '../connection/encryption';
import type { ScopedEncryptionState } from '../encryption-scope';
import { unlockLocalState, type StoredReminderKeys } from '../encryption-keys';
import { pendingReadingKey, forgetReadingKey, forgetReadingCapture } from '../encryption-fragments';
import { lockReadingStorage, unlockReadingStorage, encodeReadingValue } from './private-storage';
import { assertReadingSession, readingDatabase, type ReadingSession } from './storage';

type ReadingEncryptionState = ScopedEncryptionState;
let pending: { identity: string; promise: Promise<StoredReminderKeys | null> } | undefined;
let currentKeys: StoredReminderKeys | null = null;
let expected: ReadingEncryptionState | null = null;
let verifiedIdentity: string | undefined;
onReadingEncryptionReset(() => { pending = undefined; currentKeys = null; expected = null; verifiedIdentity = undefined; forgetReadingKey(); forgetReadingCapture(); lockReadingStorage(); });
export function readingEncryptionHeaders(): Record<string, string> {
  return expected ? { 'X-Crate-Encryption-Vault': expected.vaultId, 'X-Crate-Encryption-Generation': String(expected.generation) } : {};
}
export function prepareReadingEncryption(session: ReadingSession, refresh = false): Promise<StoredReminderKeys | null> {
  assertReadingSession(session);
  if (refresh) pending = undefined;
  const identity = JSON.stringify([session.token, session.id, session.generation, session.folderPath]);
  if (pending?.identity === identity) return pending.promise;
  const current = () => { try { assertReadingSession(session); return pending?.promise === work; } catch { return false; } };
  const work = (async () => {
    const state = await loadEncryptionState({ token: session.token, purpose: 'reading', fragment: pendingReadingKey(), current,
      request: () => fetch('/reading/encryption', { cache: 'no-store', signal: AbortSignal.timeout(20_000), headers: { Authorization: `Bearer ${session.token}`, [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current) } }) });
    expected = state;
    if (!state) { verifiedIdentity = identity; currentKeys = null; lockReadingStorage(false); return null; }
    if (!currentKeys) lockReadingStorage();
    assertEncryptionActive(state);
    const keys = await loadScopeKeys(state, session.folderPath, current, pendingReadingKey());
    forgetReadingKey();
    const local = await unlockLocalState(keys);
    if (!current()) { local.destroy(); throw new Error('Reading sign-in changed.'); }
    unlockReadingStorage(local);
    // All this session's legacy records migrate atomically before hydration. Never
    // reinterpret another session's unreadable records or silently discard them.
    const db = await readingDatabase();
    if (!current()) throw new Error('Reading sign-in changed.');
    const tx = db.transaction('values', 'readwrite');
    try {
      for (const key of await tx.store.getAllKeys()) if (['list', 'draft', 'pending'].some(kind => key === `${kind}:${session.id}`)
        || key.startsWith(`article:${session.id}:`) || key.startsWith(`attempt:${session.id}:`) || key.startsWith('share:')) {
        const value = await tx.store.get(key);
        if (!(value && typeof value === 'object' && 'encryptedReading' in value)) await tx.store.put(encodeReadingValue(key, value), key);
      }
      if (!current()) throw new Error('Reading sign-in changed.');
      await tx.done;
    } catch (error) { try { tx.abort(); } catch { /* already aborted */ } await tx.done.catch(() => {}); throw error; }
    if (!current()) throw new Error('Reading sign-in changed.');
    rememberEncryptionUnlock(state.vaultId);
    verifiedIdentity = identity;
    currentKeys = { ...keys, localFolderPath: session.folderPath };
    return currentKeys;
  })().catch(error => {
    if (current()) {
      // Losing the network must not revoke this session's verified local access.
      // The request still fails, so no unverified plaintext reaches the server.
      if (!(error instanceof EncryptionVerificationUnavailableError) || verifiedIdentity !== identity) {
        lockReadingStorage(true, error instanceof Error ? error.message : undefined);
        currentKeys = null; verifiedIdentity = undefined;
      }
      pending = undefined;
    }
    throw error;
  });
  pending = { identity, promise: work };
  // Plaintext is a current server state, not a permanent enrollment property.
  // Keep concurrent checks shared, but verify again before the next request.
  void work.then(keys => { if (!keys && pending?.promise === work) pending = undefined; }, () => {});
  return work;
}
export async function unlockReadingWithCode(code: string, session: ReadingSession): Promise<void> {
  if (!expected) throw new Error('Verify the Reading connection first.');
  const state = expected;
  const { rememberRecoveryKey } = await import('../web-app-unlock');
  await rememberRecoveryKey(code, state, session.folderPath, () => { try { assertReadingSession(session); return expected === state; } catch { return false; } });
  location.reload();
}
export function readingKeys(): StoredReminderKeys | null { return currentKeys; }
