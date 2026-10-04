import { reportExpiredConnection } from './expiration';
import { EncryptionKeyRequiredError } from '../encryption-onboarding';
import { hasEncryptedSessionEvidence, parseScopedEncryptionState, type ScopedEncryptionState } from '../encryption-scope';
import type { StoredReminderKeys } from '../encryption-keys';

export class EncryptionVerificationUnavailableError extends Error {}

/** Common verification policy for every feature; offline never downgrades known encryption. */
export async function loadEncryptionState({ token, purpose, fragment, request, current }: {
  token: string; purpose: 'reading' | 'reminders'; fragment?: string;
  request: () => Promise<Response>; current: () => boolean;
}): Promise<ScopedEncryptionState | null> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  const marker = `crate-encryption-session:${purpose === 'reading' ? 'reading:' : ''}${Array.from(digest, b => b.toString(16).padStart(2, '0')).join('')}`;
  const remembered = localStorage.getItem(marker);
  let expected: ScopedEncryptionState | null;
  try {
    const response = await request().catch((cause: unknown) => {
      throw new EncryptionVerificationUnavailableError('Could not verify encryption. Check your connection and retry.', { cause });
    });
    if (response.status === 401 && current()) reportExpiredConnection(token);
    const oldServer = purpose === 'reminders' && response.status === 404;
    if (!response.ok && !oldServer) throw new Error('Could not verify encryption. Check your connection and retry.');
    const data = oldServer ? { encryption: null } : await response.json() as { encryption: unknown };
    expected = data.encryption === null ? null : parseScopedEncryptionState(data.encryption, purpose);
    if (!expected && hasEncryptedSessionEvidence(remembered, fragment)) throw new Error('The server no longer reports this vault’s encryption configuration. Reconnect from Obsidian before syncing.');
  } catch (cause) {
    if (navigator.onLine !== false) throw cause;
    if (!remembered && hasEncryptedSessionEvidence(remembered, fragment)) throw new Error('Go online once to verify this encrypted connection.');
    expected = remembered ? parseScopedEncryptionState(JSON.parse(remembered), purpose) : null;
  }
  if (!current()) throw new Error('Connection changed before unlocking.');
  if (expected) localStorage.setItem(marker, JSON.stringify(expected));
  return expected;
}

/** Shared key import and scope checks; features retain their own local-data hydration. */
export async function loadScopeKeys(expected: ScopedEncryptionState, localFolder: string, current: () => boolean, code?: string): Promise<StoredReminderKeys> {
  const { readReminderKeys, followEncryptionScope } = await import('../encryption-keys');
  if (code) await (await import('../web-app-unlock')).rememberRecoveryKey(code, expected, localFolder, current);
  const saved = await readReminderKeys(expected.vaultId, expected.scope.id);
  if (!saved) throw new EncryptionKeyRequiredError(expected.vaultId);
  const keys = await followEncryptionScope(saved, expected, localFolder, current);
  if (keys.version !== 1 || keys.vaultId !== expected.vaultId || keys.scopeId !== expected.scope.id
    || keys.folderPath !== expected.scope.folderPath || keys.generation !== expected.generation
    || keys.data.id !== expected.scope.keyId || keys.notifications.id !== expected.scope.notificationKeyId) {
    throw new Error('Unlock Crate with the recovery key from Obsidian.');
  }
  return keys;
}

export class EncryptionTransitionError extends Error {
  constructor(readonly mode: string) {
    super(mode === 'resetting' ? 'Encryption reset is in progress. Resume it in Obsidian, then reconnect this app.' : 'Encryption conversion is in progress. Resume it in Obsidian.');
  }
}
export function assertEncryptionActive(state: ScopedEncryptionState): void {
  if (state.mode !== 'active') throw new EncryptionTransitionError(state.mode);
}
