import assert from 'node:assert/strict';

export async function verifyFolderKeyFollowing(page) {
  const result = await page.evaluate(async () => {
    const t = window.encryptionStorageTest;
    const initial = t.addReminderScope(t.createVaultKeyBundle(), 'Reminders');
    const grant = t.createReminderKeyGrant(initial, 'Reminders');
    const stored = await t.rememberReminderKeys(grant);
    const cipher = await t.unlockLocalState(stored);
    const draft = cipher.seal('private unsent draft', 'saved-draft');
    const moved = t.moveEncryptionScopes(t.moveEncryptionScopes(initial, 'Reminders', 'Tasks'), 'Tasks', 'Personal/Tasks');
    const recovery = await t.generateRecoveryCode();
    const full = await t.bindEncryptionScopes(t.createEncryptionState(moved, await t.sealRecoveryBundle(moved, recovery)), moved);
    const state = { ...full, mode: 'active', scope: full.scopes[0] };
    const read = () => t.readReminderKeys(stored.vaultId, stored.scopeId);
    let denied = 0;
    for (const bad of [
      { ...state, scope: { ...state.scope, folderPath: 'Private' } },
      { ...state, generation: state.generation + 1 },
      { ...state, scope: { ...state.scope, binding: undefined } },
      { ...state, scope: { ...state.scope, accessId: 'another-folder' } },
    ]) {
      try { await t.followEncryptionScope(stored, bad, 'Reminders', () => true); } catch { denied++; }
      if ((await read()).folderPath !== 'Reminders') throw new Error('An unverified path changed persisted keys');
    }
    const followed = await t.followEncryptionScope(stored, state, 'Reminders', () => true);
    if (followed.folderPath !== 'Personal/Tasks' || followed.localFolderPath !== 'Reminders'
      || followed.localState !== stored.localState || (await t.unlockLocalState(followed)).open(draft, 'saved-draft') !== 'private unsent draft') throw new Error('A move lost the durable namespace or draft key');
    // A peer finishing the same move must converge without replacing the local key.
    await t.followEncryptionScope(stored, state, 'Reminders', () => true);
    const next = t.moveEncryptionScopes(moved, 'Personal/Tasks', 'Later/Tasks');
    const nextFull = await t.bindEncryptionScopes(t.createEncryptionState(next, await t.sealRecoveryBundle(next, recovery)), next);
    try { await t.followEncryptionScope(followed, { ...nextFull, scope: nextFull.scopes[0] }, 'Reminders', () => false); } catch { denied++; }
    if ((await read()).folderPath !== 'Personal/Tasks') throw new Error('A signed-out operation moved keys');
    const previous = await t.bindEncryptionScopes(t.createEncryptionState(initial, await t.sealRecoveryBundle(initial, recovery)), initial);
    try { await t.followEncryptionScope(followed, { ...previous, scope: previous.scopes[0] }, 'Reminders', () => true); } catch { denied++; }
    const replaced = t.moveEncryptionScopes(moved, 'Personal/Tasks', 'Work', 'new-folder');
    const replacement = await t.bindEncryptionScopes(t.createEncryptionState(replaced, await t.sealRecoveryBundle(replaced, recovery)), replaced);
    try { await t.followEncryptionScope(followed, { ...replacement, scope: replacement.scopes[0] }, 'Reminders', () => true); } catch { denied++; }
    // The production bootstrap follows the verified mapping without a pasted key.
    localStorage.setItem(t.AUTH_TOKEN_KEY, 'same-browser-session');
    localStorage.setItem('crate-reminders-config', JSON.stringify({ folderPath: 'Reminders', upcomingDays: 7 }));
    t.resetPwaEncryption(true);
    const ready = await t.preparePwaEncryption('same-browser-session', async () => Response.json({ encryption: state }));
    if (ready.folderPath !== 'Personal/Tasks' || ready.localFolderPath !== 'Reminders' || t.encryptionSnapshot().status !== 'ready') throw new Error('Bootstrap did not follow the folder');
    // Pasting the current grant after a move restores keys without losing the
    // old durable namespace or the secret protecting pending drafts.
    const recovered = await t.rememberReminderKeys(t.createReminderKeyGrant(moved, 'Personal/Tasks'), () => true, 'Reminders');
    const reopened = await t.followEncryptionScope(recovered, state, 'Reminders', () => true);
    if ((await t.unlockLocalState(reopened)).open(draft, 'saved-draft') !== 'private unsent draft') throw new Error('Key recovery after a move lost the draft');
    return { denied, localKeyUnchanged: ready.localState === stored.localState };
  });
  assert.deepEqual(result, { denied: 7, localKeyUnchanged: true });
}
