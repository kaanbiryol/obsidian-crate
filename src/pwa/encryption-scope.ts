import { isEncryptionId } from '../encryption/encoding';
import { isEncryptionFolderPath, type ReminderKeyGrant, type RecoveryEnvelope } from '../encryption/key-bundle';
import type { EncryptionScope } from '../encryption/server-state';

/** Shared validation for the two folder-scoped PWA enrollment flows. */
export interface ScopedEncryptionState {
  version: 1; vaultId: string; generation: number; mode: 'active' | 'converting' | 'resetting';
  scope: EncryptionScope;
  /** Optional for already-unlocked clients connected to an older server. */
  recovery?: RecoveryEnvelope;
}

export function parseScopedEncryptionState(value: unknown, feature: 'reading' | 'reminders'): ScopedEncryptionState {
  const state = value as Partial<ScopedEncryptionState> | null;
  if (!state || state.version !== 1 || !isEncryptionId(state.vaultId) || !Number.isSafeInteger(state.generation) || state.generation! < 1
    || !['active', 'converting', 'resetting'].includes(state.mode ?? '') || !state.scope
    || !isEncryptionId(state.scope.id) || !isEncryptionId(state.scope.keyId) || !isEncryptionId(state.scope.notificationKeyId)
    || !isEncryptionFolderPath(state.scope.folderPath) || state.scope.purpose !== (feature === 'reading' ? 'reading' : undefined)
    || state.scope.accessId !== undefined && !isEncryptionId(state.scope.accessId)
    || state.scope.binding !== undefined && (typeof state.scope.binding !== 'string' || state.scope.binding.length > 8192)) {
    throw new Error('Invalid encrypted enrollment configuration');
  }
  if (state.recovery !== undefined && (!state.recovery || state.recovery.version !== 1 || state.recovery.vaultId !== state.vaultId
    || typeof state.recovery.envelope !== 'string' || state.recovery.envelope.length > 256 * 1024 || state.recovery.envelope.split('.').length !== 5)) {
    throw new Error('Invalid encrypted recovery bundle');
  }
  return state as ScopedEncryptionState;
}

export function assertScopeGrant(grant: ReminderKeyGrant, state: ScopedEncryptionState): void {
  if (grant.vaultId !== state.vaultId || grant.generation !== state.generation || grant.scope.id !== state.scope.id
	|| (grant.scope.accessId ?? grant.scope.id) !== (state.scope.accessId ?? state.scope.id)
    || grant.scope.folderPath !== state.scope.folderPath || grant.scope.purpose !== state.scope.purpose
    || grant.scope.data.id !== state.scope.keyId || grant.scope.notifications.id !== state.scope.notificationKeyId) {
    throw new Error('This recovery key does not match the current enrollment');
  }
}

export function hasEncryptedSessionEvidence(remembered: string | null, incoming: string | undefined): boolean {
  return !!(remembered || incoming || Object.keys(localStorage).some(key => key.startsWith('crate-encryption-session:')));
}
