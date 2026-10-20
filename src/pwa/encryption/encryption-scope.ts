import { isEncryptionId } from '../../encryption/encoding';
import { isRecoveryEnvelope, type ReminderKeyGrant, type RecoveryEnvelope } from '../../encryption/key-bundle';
import { assertEncryptionScope, type EncryptionScope } from '../../encryption/server-state';

/** Shared validation for the two folder-scoped PWA enrollment flows. */
export interface ScopedEncryptionState {
  version: 1; vaultId: string; generation: number; mode: 'active' | 'converting' | 'resetting';
  scope: EncryptionScope;
  recovery: RecoveryEnvelope;
}

function isEncryptionScope(scope: unknown): scope is EncryptionScope {
  try { assertEncryptionScope(scope); return true; } catch { return false; }
}

export function parseScopedEncryptionState(value: unknown, feature: 'reading' | 'reminders'): ScopedEncryptionState {
  const state = value as Partial<ScopedEncryptionState> | null;
  if (!state || state.version !== 1 || !isEncryptionId(state.vaultId) || !Number.isSafeInteger(state.generation) || state.generation! < 1
    || !['active', 'converting', 'resetting'].includes(state.mode ?? '') || !isEncryptionScope(state.scope)
    || state.scope.purpose !== (feature === 'reading' ? 'reading' : undefined)) {
    throw new Error('Invalid encrypted enrollment configuration');
  }
  if (!isRecoveryEnvelope(state.recovery, state.vaultId)) throw new Error('Invalid encrypted recovery bundle');
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
