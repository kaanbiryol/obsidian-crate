import { reportExpiredConnection } from './expiration';
import { EncryptionKeyRequiredError } from '../encryption/encryption-onboarding';
import { validateEncryptionState, type EncryptionServerState } from '../../encryption/server-state';
import { readVaultKeys, type FeatureKeys } from '../encryption/encryption-keys';
import { rememberRecoveryKey } from '../encryption/web-app-unlock';
import { PathTags } from '../../encryption/path-tags';
import { openFolderLabel } from '../../encryption/folder-label';

export function hasEncryptedSessionEvidence(remembered: string | null, incoming: string | undefined): boolean {
  return !!(remembered || incoming || Object.keys(localStorage).some(key => key.startsWith('crate-encryption-session:')));
}

function parseEncryptionState(value: unknown): EncryptionServerState {
  try { validateEncryptionState(value); return value; } catch { throw new Error('Invalid encrypted enrollment configuration'); }
}

export class EncryptionVerificationUnavailableError extends Error {}

/** Common verification policy for every feature; offline never downgrades known encryption. */
/** The verified configuration, and in an encrypted vault the sealed name of the
 * feature folder the session reads. */
export interface VerifiedEncryption { state: EncryptionServerState; folderLabel: string | null; folderPath: string | null }

export async function loadEncryptionState({ token, purpose, fragment, request, current }: {
  token: string; purpose: 'reading' | 'reminders'; fragment?: string;
  request: () => Promise<Response>; current: () => boolean;
}): Promise<VerifiedEncryption | null> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  const marker = `crate-encryption-session:${purpose === 'reading' ? 'reading:' : ''}${Array.from(digest, b => b.toString(16).padStart(2, '0')).join('')}`;
  const remembered = localStorage.getItem(marker);
  let expected: EncryptionServerState | null;
  let folderLabel: string | null = null, folderPath: string | null = null;
  try {
    const response = await request().catch((cause: unknown) => {
      throw new EncryptionVerificationUnavailableError('Could not verify encryption. Check your connection and retry.', { cause });
    });
    if (response.status === 401 && current()) reportExpiredConnection(token);
    if (!response.ok) throw new Error('Could not verify encryption. Check your connection and retry.');
    const data = await response.json() as { encryption: unknown; folderLabel?: unknown; folderPath?: unknown };
    expected = data.encryption === null ? null : parseEncryptionState(data.encryption);
    folderLabel = typeof data.folderLabel === 'string' ? data.folderLabel : null;
    folderPath = typeof data.folderPath === 'string' ? data.folderPath : null;
    if (!expected && hasEncryptedSessionEvidence(remembered, fragment)) throw new Error('The server no longer reports this vault’s encryption configuration. Reconnect from Obsidian before syncing.');
  } catch (cause) {
    if (navigator.onLine !== false) throw cause;
    if (!remembered && hasEncryptedSessionEvidence(remembered, fragment)) throw new Error('Go online once to verify this encrypted connection.');
    expected = remembered ? parseEncryptionState(JSON.parse(remembered)) : null;
    const folder = JSON.parse(localStorage.getItem(`${marker}:folder`) ?? 'null') as { path?: unknown; label?: unknown } | null;
    folderLabel = typeof folder?.label === 'string' ? folder.label : null;
    folderPath = typeof folder?.path === 'string' ? folder.path : null;
  }
  if (!current()) throw new Error('Connection changed before unlocking.');
  if (expected) localStorage.setItem(marker, JSON.stringify(expected));
  if (expected && folderLabel) localStorage.setItem(`${marker}:folder`, JSON.stringify({ path: folderPath, label: folderLabel }));
  return expected && { state: expected, folderLabel, folderPath };
}

/** Shared key import and checks; features retain their own local-data hydration.
 * `wireFolder` is the feature folder as the server names it; its label holds the plaintext name. */
export async function loadVaultKeys({ state: expected, folderLabel }: VerifiedEncryption, wireFolder: string, current: () => boolean, code?: string): Promise<FeatureKeys> {
  if (code) await rememberRecoveryKey(code, expected, current);
  const keys = await readVaultKeys(expected.vaultId);
  if (!keys) throw new EncryptionKeyRequiredError(expected.vaultId);
  if (keys.generation !== expected.generation || keys.vault.id !== expected.keyId || keys.notifications.id !== expected.notificationKeyId
    || keys.seal.keyId !== expected.seal.keyId || keys.seal.publicKey !== expected.seal.publicKey) {
    throw new Error('Unlock Crate with the recovery key from Obsidian.');
  }
  if (!folderLabel) throw new Error('Update the Crate server and reconnect this app from Obsidian.');
  const paths = new PathTags(keys.pathTag);
  return { ...keys, folderPath: await openFolderLabel(wireFolder, folderLabel, paths, keys.vault, keys.vaultId), wireFolder, paths };
}

export class EncryptionTransitionError extends Error {
  constructor(readonly mode: string) {
    super('Encryption reset is in progress. Resume it in Obsidian, then reconnect this app.');
  }
}
export function assertEncryptionActive(state: EncryptionServerState): void {
  if (state.mode !== 'active') throw new EncryptionTransitionError(state.mode);
}
