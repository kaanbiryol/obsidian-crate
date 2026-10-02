import { onReadingEncryptionReset } from './encryption-lifecycle';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol';
import { hasEncryptedSessionEvidence, parseScopedEncryptionState, type ScopedEncryptionState } from '../encryption-scope';
import { readReminderKeys, unlockLocalState, followEncryptionScope, type StoredReminderKeys } from '../encryption-keys';
import { pendingReadingKey, forgetReadingKey, forgetReadingCapture } from '../encryption-fragments';
import { lockReadingStorage, unlockReadingStorage, encodeReadingValue } from './private-storage';
import { assertReadingSession, readingDatabase, type ReadingSession } from './storage';

type ReadingEncryptionState = ScopedEncryptionState;
let pending: { identity: string; promise: Promise<StoredReminderKeys | null> } | undefined;
let currentKeys: StoredReminderKeys | null = null;
let expected: ReadingEncryptionState | null = null;
onReadingEncryptionReset(() => { pending = undefined; currentKeys = null; expected = null; forgetReadingKey(); forgetReadingCapture(); lockReadingStorage(); });
export function readingEncryptionHeaders(): Record<string, string> {
  return expected ? { 'X-Crate-Encryption-Vault': expected.vaultId, 'X-Crate-Encryption-Generation': String(expected.generation) } : {};
}
function validate(value: unknown): ReadingEncryptionState {
  const state = parseScopedEncryptionState(value, 'reading');
  return state;
}
export function prepareReadingEncryption(session: ReadingSession, refresh = false): Promise<StoredReminderKeys | null> {
  assertReadingSession(session);
  if (refresh) pending = undefined;
  const identity = JSON.stringify([session.token, session.id, session.generation, session.folderPath]);
  if (pending?.identity === identity) return pending.promise;
  const current = () => { try { assertReadingSession(session); return pending?.promise === work; } catch { return false; } };
  const work = (async () => {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(session.token)));
    const marker = 'crate-encryption-session:reading:' + Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
    const remembered = localStorage.getItem(marker);
    let state: ReadingEncryptionState | null;
    try {
      const response = await fetch('/reading/encryption', { cache: 'no-store', signal: AbortSignal.timeout(20_000), headers: { Authorization: `Bearer ${session.token}`, [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current) } });
      if (!response.ok) throw new Error('Could not verify Reading encryption. Reconnect before syncing.');
      const data = await response.json() as { encryption: unknown };
      state = data.encryption === null ? null : validate(data.encryption);
      if (!state && hasEncryptedSessionEvidence(remembered, pendingReadingKey())) throw new Error('Reading encryption changed. Reconnect from Obsidian.');
    } catch (error) {
      if (navigator.onLine) throw error;
      if (!remembered && hasEncryptedSessionEvidence(remembered, pendingReadingKey())) throw new Error('Connect once to verify Reading encryption.');
      state = remembered ? validate(JSON.parse(remembered)) : null;
    }
    if (!current()) throw new Error('Reading sign-in changed.');
    expected = state;
    if (!state) { currentKeys = null; lockReadingStorage(false); return null; }
    localStorage.setItem(marker, JSON.stringify(state));
    if (!currentKeys) lockReadingStorage();
    if (state.mode !== 'active') throw new Error('Finish the encryption conversion or reset in Obsidian before opening Reading.');
    const grant = pendingReadingKey();
    if (grant) { await rememberGrant(grant, session, state, current); forgetReadingKey(); }
    let keys = await readReminderKeys(state.vaultId, state.scope.id);
    if (!keys) throw new Error('Unlock Reading with the web app key from Crate settings in Obsidian.');
    keys = await followEncryptionScope(keys, state, session.folderPath, current);
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
    currentKeys = { ...keys, localFolderPath: session.folderPath };
    return currentKeys;
  })().catch(error => { if (current()) { lockReadingStorage(true, error instanceof Error ? error.message : undefined); currentKeys = null; pending = undefined; } throw error; });
  pending = { identity, promise: work };
  // Plaintext is a current server state, not a permanent enrollment property.
  // Keep concurrent checks shared, but verify again before the next request.
  void work.then(keys => { if (!keys && pending?.promise === work) pending = undefined; }, () => {});
  return work;
}
async function rememberGrant(code: string, session: ReadingSession, state: ReadingEncryptionState, current: () => boolean): Promise<void> {
  const { rememberWebAppKey } = await import('../web-app-unlock');
  await rememberWebAppKey(code, state, session.folderPath, current);
}
export async function unlockReadingWithCode(code: string, session: ReadingSession): Promise<void> {
  if (!expected) throw new Error('Verify the Reading connection first.');
  const { rememberWebAppKey } = await import('../web-app-unlock');
  await rememberWebAppKey(code, expected, session.folderPath, () => { try { assertReadingSession(session); return true; } catch { return false; } });
  location.reload();
}
export function readingKeys(): StoredReminderKeys | null { return currentKeys; }
