import { decryptJson, encryptJson, importEncryptionSecret, type EncryptionKey } from './envelope';
import type { VaultKeyBundle } from './key-bundle';
import type { EncryptionScope, EncryptionServerState } from './server-state';

export interface BoundScopeState { vaultId: string; generation: number; scope: EncryptionScope }
const context = (state: BoundScopeState) => ({ vaultId: state.vaultId, scopeId: state.scope.id, objectId: 'folder-binding', purpose: 'settings' as const });
const identity = (state: BoundScopeState) => ({ version: 1, vaultId: state.vaultId, generation: state.generation,
  scopeId: state.scope.id, folderPath: state.scope.folderPath, purpose: state.scope.purpose ?? 'reminders',
  accessId: state.scope.accessId ?? state.scope.id, keyId: state.scope.keyId, notificationKeyId: state.scope.notificationKeyId });

/** An unlocked client, never the server, authorizes the current path of a scope.
 * A snapshot permits recovery after several offline renames without a path log. */
export async function bindEncryptionScopes(state: EncryptionServerState, bundle: VaultKeyBundle): Promise<EncryptionServerState> {
  return { ...state, scopes: await Promise.all(state.scopes.map(async scope => ({ ...scope,
    binding: await encryptJson(identity({ ...state, scope }), await importEncryptionSecret(bundle.scopes.find(key => key.id === scope.id)!.data), context({ ...state, scope })),
  }))) };
}

export async function verifyScopeBinding(state: BoundScopeState, key: EncryptionKey): Promise<void> {
  if (!state.scope.binding) throw new Error('Reconnect this folder using a fresh setup link.');
  const value = await decryptJson(state.scope.binding, key, context(state));
  const expected = identity(state);
  if (!value || typeof value !== 'object' || Object.keys(value).length !== Object.keys(expected).length
    || Object.entries(expected).some(([name, field]) => (value as Record<string, unknown>)[name] !== field)) {
    throw new Error('The encrypted folder location could not be verified.');
  }
}
