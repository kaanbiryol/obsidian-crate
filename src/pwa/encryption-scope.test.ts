import { expect, it } from 'vitest';
import { addReminderScope, createReminderKeyGrant, createVaultKeyBundle } from '../encryption/key-bundle';
import { assertScopeGrant, parseScopedEncryptionState } from './encryption-scope';

function fixture(purpose?: 'reading') {
  const grant = createReminderKeyGrant(addReminderScope(createVaultKeyBundle(), 'Private', purpose), 'Private');
  const state = { version: 1 as const, vaultId: grant.vaultId, generation: grant.generation, mode: 'active' as const,
    scope: { id: grant.scope.id, folderPath: grant.scope.folderPath, keyId: grant.scope.data.id, notificationKeyId: grant.scope.notifications.id, purpose } };
  return { grant, state };
}

it.each(['reading', 'reminders'] as const)('validates the complete %s authority before any key is remembered', feature => {
  const { grant, state } = fixture(feature === 'reading' ? 'reading' : undefined);
  expect(parseScopedEncryptionState(state, feature)).toEqual(state);
  expect(() => assertScopeGrant(grant, state)).not.toThrow();
  for (const changed of [
    { ...state, generation: state.generation + 1 },
    { ...state, vaultId: crypto.randomUUID() },
    { ...state, scope: { ...state.scope, folderPath: 'Other' } },
    { ...state, scope: { ...state.scope, keyId: crypto.randomUUID() } },
    { ...state, scope: { ...state.scope, notificationKeyId: crypto.randomUUID() } },
    { ...state, scope: { ...state.scope, purpose: feature === 'reading' ? undefined : 'reading' as const } },
  ]) expect(() => assertScopeGrant(grant, changed)).toThrow('does not match');
  expect(() => parseScopedEncryptionState(state, feature === 'reading' ? 'reminders' : 'reading')).toThrow();
  for (const folderPath of ['', '../Private', '/Private', 'Private//Tasks', 'Private\\Tasks']) {
    expect(() => parseScopedEncryptionState({ ...state, scope: { ...state.scope, folderPath } }, feature)).toThrow();
  }
});
