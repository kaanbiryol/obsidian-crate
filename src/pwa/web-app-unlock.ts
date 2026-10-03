import { createReminderKeyGrant, openRecoveryBundle, validateReminderKeyGrant, type ReminderKeyGrant } from '../encryption/key-bundle';
import { assertScopeGrant, type ScopedEncryptionState } from './encryption-scope';
import { rememberReminderKeys } from './encryption-keys';
import { AUTH_TOKEN_KEY, loadStoredConfig } from './config';
import { READING_SESSION_KEY, readingSession } from './reading/storage';
import { capturePwaSession } from './session-generation';
import { verifyScopeBinding } from '../encryption/scope-binding';
import { importEncryptionSecret } from '../encryption/envelope';

function connectionGuard(sessionCurrent: () => boolean) {
  const remindersCurrent = capturePwaSession();
  const readingIdentity = localStorage.getItem(READING_SESSION_KEY);
  const remindersFolder = loadStoredConfig().folderPath;
  return () => sessionCurrent() && remindersCurrent()
    && localStorage.getItem(READING_SESSION_KEY) === readingIdentity && loadStoredConfig().folderPath === remindersFolder;
}

async function storeBrowserGrants(grants: ReminderKeyGrant[], expected: ScopedEncryptionState, localFolder: string, current: () => boolean): Promise<void> {
  if (expected.mode !== 'active') throw new Error('Finish encryption setup in Obsidian before unlocking.');
  if (!current()) throw new Error('The web app connection changed. Retry unlocking.');
  const primary = grants.find(grant => grant.scope.id === expected.scope.id);
  if (!primary) throw new Error('These keys do not include the connected folder');
  assertScopeGrant(primary, expected);
  const remindersFolder = loadStoredConfig().folderPath;
  const remindersConnected = !!localStorage.getItem(AUTH_TOKEN_KEY);
  const candidates = grants.filter(grant => grant.scope.purpose !== primary.scope.purpose);
  const reading = candidates.length ? readingSession() : null;
  const siblingFolder = primary.scope.purpose === 'reading' ? remindersConnected ? remindersFolder : undefined : reading?.folderPath;
  const sibling = candidates.find(grant => grant.scope.folderPath === siblingFolder) ?? (candidates.length === 1 ? candidates[0] : undefined);
  for (const grant of grants.filter(grant => grant === primary || grant === sibling)) {
    if (!current()) throw new Error('The web app connection changed. Retry unlocking.');
    const folder = grant === primary ? localFolder : grant.scope.purpose === 'reading'
      ? reading?.folderPath : remindersConnected ? remindersFolder : undefined;
    await rememberReminderKeys(grant, current, folder);
  }
  if (!current()) throw new Error('The web app connection changed. Retry unlocking.');
}

/** Open the recovery bundle locally, then retain only browser feature keys.
 * Neither the recovery code nor the full vault key is persisted in the PWA. */
export async function rememberRecoveryKey(code: string, expected: ScopedEncryptionState, localFolder: string, sessionCurrent: () => boolean): Promise<void> {
  if (!expected.recovery) throw new Error('Update your Crate server in Obsidian before unlocking with the recovery key.');
  const current = connectionGuard(sessionCurrent);
  if (!current()) throw new Error('The web app connection changed. Retry unlocking.');
  const bundle = await openRecoveryBundle(expected.recovery, code);
  await storeBrowserGrants(bundle.scopes.map(scope => createReminderKeyGrant(bundle, scope.folderPath)), expected, localFolder, current);
}

/** Accept only the two browser scopes from an approved encrypted transfer. */
export async function rememberPairingGrants(payload: unknown, expected: ScopedEncryptionState, localFolder: string, sessionCurrent: () => boolean): Promise<void> {
  const current = connectionGuard(sessionCurrent);
  const packet = payload as { grants?: unknown[] } | null;
  if (!packet || Object.keys(packet).join() !== 'grants' || !Array.isArray(packet.grants) || !packet.grants.length || packet.grants.length > 2) throw new Error('Invalid app key transfer.');
  const grants: ReminderKeyGrant[] = [];
  for (const value of packet.grants) {
    validateReminderKeyGrant(value);
    if (value.vaultId !== expected.vaultId || value.generation !== expected.generation || grants.some(grant => grant.scope.purpose === value.scope.purpose || grant.scope.id === value.scope.id)) throw new Error('This transfer does not match the connected vault.');
    grants.push(value);
  }
  const primary = grants.find(grant => grant.scope.id === expected.scope.id);
  if (!primary) throw new Error('These keys do not include the connected folder');
  assertScopeGrant(primary, expected);
  await verifyScopeBinding(expected, await importEncryptionSecret(primary.scope.data));
  await storeBrowserGrants(grants, expected, localFolder, current);
}
