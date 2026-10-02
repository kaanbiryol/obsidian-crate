import { decodeWebAppKey } from '../encryption/web-app-key';
import { assertScopeGrant, type ScopedEncryptionState } from './encryption-scope';
import { rememberReminderKeys } from './encryption-keys';
import { AUTH_TOKEN_KEY, loadStoredConfig } from './config';
import { READING_SESSION_KEY, readingSession } from './reading/storage';
import { capturePwaSession } from './session-generation';

/** Import the user-selected folder grants. Each feature still validates its own
 * server enrollment before reading data. No code or raw secret is persisted. */
export async function rememberWebAppKey(code: string, expected: ScopedEncryptionState, localFolder: string, sessionCurrent: () => boolean): Promise<void> {
  const grants = decodeWebAppKey(code);
  const primary = grants.find(grant => grant.scope.id === expected.scope.id);
  if (!primary) throw new Error('This web app key does not include the connected folder');
  assertScopeGrant(primary, expected);
  if (grants.length === 1) { await rememberReminderKeys(primary, sessionCurrent, localFolder); return; }
  const remindersCurrent = capturePwaSession();
  const readingIdentity = localStorage.getItem(READING_SESSION_KEY);
  const reading = readingSession();
  const remindersFolder = loadStoredConfig().folderPath;
  const remindersConnected = !!localStorage.getItem(AUTH_TOKEN_KEY);
  const current = () => sessionCurrent() && remindersCurrent()
    && localStorage.getItem(READING_SESSION_KEY) === readingIdentity && loadStoredConfig().folderPath === remindersFolder;
  for (const grant of grants) {
    if (!current()) throw new Error('The web app connection changed. Retry unlocking.');
    // Preserve each connected feature's local namespace, including a folder
    // renamed since enrollment. Existing wrapped draft keys are retained.
    const folder = grant === primary ? localFolder : grant.scope.purpose === 'reading'
      ? reading?.folderPath : remindersConnected ? remindersFolder : undefined;
    await rememberReminderKeys(grant, current, folder);
  }
  if (!current()) throw new Error('The web app connection changed. Retry unlocking.');
}
