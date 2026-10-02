import { expect, it } from 'vitest';
import { addReminderScope, createVaultKeyBundle, generateRecoveryCode, moveEncryptionScopes, sealRecoveryBundle } from './key-bundle';
import { bindEncryptionScopes, verifyScopeBinding } from './scope-binding';
import { createEncryptionState } from './server-state';
import { importEncryptionSecret } from './envelope';

it('authenticates a current folder after multiple moves without changing any keys', async () => {
  const initial = addReminderScope(createVaultKeyBundle(), 'Reading', 'reading');
  const moved = moveEncryptionScopes(moveEncryptionScopes(initial, 'Reading', 'Articles'), 'Articles', 'Saved/Articles');
  const state = await bindEncryptionScopes(createEncryptionState(moved, await sealRecoveryBundle(moved, await generateRecoveryCode())), moved);
  const scoped = { ...state, scope: state.scopes[0]! }, key = await importEncryptionSecret(initial.scopes[0]!.data);
  await expect(verifyScopeBinding(scoped, key)).resolves.toBeUndefined();
  expect(moved.scopes[0]!.data).toEqual(initial.scopes[0]!.data);
  expect(moved.scopes[0]!.id).toBe(initial.scopes[0]!.id);
  for (const change of [{ folderPath: 'Private' }, { accessId: 'replaced-folder' }, { purpose: undefined }, { notificationKeyId: 'other-key' }]) {
    await expect(verifyScopeBinding({ ...scoped, scope: { ...scoped.scope, ...change } }, key)).rejects.toThrow();
  }
  await expect(verifyScopeBinding({ ...scoped, generation: state.generation + 1 }, key)).rejects.toThrow();
  await expect(verifyScopeBinding({ ...scoped, vaultId: 'another-vault' }, key)).rejects.toThrow();
  await expect(verifyScopeBinding({ ...scoped, scope: { ...scoped.scope, id: 'another-scope' } }, key)).rejects.toThrow();
});

it('distinguishes selecting different content from renaming the existing folder', () => {
  const initial = addReminderScope(createVaultKeyBundle(), 'Reading', 'reading');
  const changed = moveEncryptionScopes(initial, 'Reading', 'Work', 'replacement');
  expect(changed.scopes[0]!.accessId).toBe('replacement');
  expect(moveEncryptionScopes(changed, 'Work', 'Projects/Work').scopes[0]!.accessId).toBe('replacement');
  expect(changed.scopes[0]!.data).toEqual(initial.scopes[0]!.data);
});
