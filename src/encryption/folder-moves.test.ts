import { expect, it } from 'vitest';
import { addReminderScope, createVaultKeyBundle, createReminderKeyGrant, generateRecoveryCode, moveEncryptionScopes, sealRecoveryBundle } from './key-bundle';
import { createEncryptionState, isEncryptionScopeMove } from './server-state';
import { FileKeyAuthority } from './file-authority';

const bundle = () => addReminderScope(addReminderScope(createVaultKeyBundle(), 'Projects/Tasks'), 'Projects/Reading', 'reading');
it('moves an enrolled parent while retaining every key and purpose', async () => {
  const keys = bundle(), next = moveEncryptionScopes(keys, 'Projects', 'Personal/Projects');
  expect(next.generation).toBe(keys.generation + 1);
  expect(next.scopes.map(scope => scope.folderPath)).toEqual(['Personal/Projects/Tasks', 'Personal/Projects/Reading']);
  expect(next.scopes.map(({ folderPath: _, ...scope }) => scope)).toEqual(keys.scopes.map(({ folderPath: _, ...scope }) => scope));
  expect(next.vault).toEqual(keys.vault);
  const recovery = await sealRecoveryBundle(keys, await generateRecoveryCode());
  const prior = { ...createEncryptionState(keys, recovery), mode: 'active' as const };
  expect(isEncryptionScopeMove(prior, createEncryptionState(next, recovery))).toBe(true);
  expect(isEncryptionScopeMove(prior, createEncryptionState({ ...next, vault: createVaultKeyBundle().vault }, recovery))).toBe(false);
});
it('does not broaden a file rename or a sibling folder into a scope move', () => {
  const keys = bundle();
  expect(moveEncryptionScopes(keys, 'Projects/Tasks/Note.md', 'Private/Note.md')).toBe(keys);
  expect(moveEncryptionScopes(keys, 'Project', 'Private')).toBe(keys);
});
it('rejects overlapping and invalid destinations before changing keys', () => {
  const keys = bundle();
  for (const path of ['Projects/Reading', 'Projects/Reading/Nested', '../Private', '/Private']) {
    expect(() => moveEncryptionScopes(keys, 'Projects/Tasks', path)).toThrow();
  }
});
it('allows full-vault conversion with the prior folder key without broadening a web grant', async () => {
  const keys = bundle(), scope = keys.scopes[0]!, next = moveEncryptionScopes(keys, 'Projects', 'Moved');
  const vault = await FileKeyAuthority.fromVault(next);
  expect(vault.forPriorScope(scope.id, scope.data.id).key.id).toBe(scope.data.id);
  expect(() => vault.forPriorScope(scope.id, 'unknown')).toThrow();
  const web = await FileKeyAuthority.fromReminderGrant(createReminderKeyGrant(next, 'Moved/Tasks'));
  expect(() => web.forPriorScope(scope.id, scope.data.id)).toThrow();
  expect(() => web.forPath('Projects/Tasks/Private.md')).toThrow();
});
