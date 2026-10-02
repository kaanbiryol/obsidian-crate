import { resetReadingEncryption } from './encryption-lifecycle';
import { resetPwaEncryption } from '../encryption-session';
import { captureEncryptionCleanupAuthority, clearEncryptionSessionMarkers, clearPersistedEncryption } from '../encryption-cleanup';
import { AUTH_TOKEN_KEY, PWA_LOGOUT_KEY, finishEnrollment } from '../config';
import { clearReminderDrafts } from '../reminder-drafts';
import { clearReminderOutbox } from '../reminder-outbox-storage';
import { clearCachedReminderSnapshots } from '../reminder-cache';
import { invalidatePwaSession } from '../session-generation';
import { clearReadingData, readingSession } from './storage';
import { CRATE_PROTOCOL_HEADER, CRATE_PLUGIN_PROTOCOL } from '@/protocol';

export async function logoutReadingApp(): Promise<string | null> {
  // Capture each credential independently; corruption must not prevent logout.
  let reading: ReturnType<typeof readingSession> = null;
  let reminders: string | null = null;
  let credentialsUnavailable = false;
  try { reading = readingSession(); } catch { credentialsUnavailable = true; }
  try { reminders = localStorage.getItem(AUTH_TOKEN_KEY); } catch { credentialsUnavailable = true; }
  invalidatePwaSession();
  resetPwaEncryption(true); resetReadingEncryption();
  let isCurrent: () => boolean;
  try { isCurrent = captureEncryptionCleanupAuthority(); }
  catch { isCurrent = () => { throw new Error('Browser storage is unavailable'); }; }
  const remote = Promise.allSettled([...new Set([reading?.token, reminders].filter((token): token is string => !!token))].map(async token => {
    const response = await fetch('/auth/session', { method: 'DELETE', signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${token}`, [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current) } });
    if (!response.ok) throw new Error('Session revocation failed');
  }));
  let failed = false;
  const attempt = async (action: () => unknown) => { try { let allowed = true; try { allowed = isCurrent(); } catch { failed = true; } if (!allowed) return; if (await action() === false) failed = true; } catch { failed = true; } };
  await attempt(() => localStorage.removeItem(AUTH_TOKEN_KEY));
  await attempt(() => localStorage.setItem(PWA_LOGOUT_KEY, crypto.randomUUID()));
  await attempt(() => finishEnrollment(false));
  await attempt(() => { document.cookie = 'crate-reading-install=; Max-Age=0; Path=/notifications; SameSite=Strict; Secure'; });
  await attempt(() => clearEncryptionSessionMarkers(isCurrent));
  await attempt(() => clearReadingData(isCurrent)); await attempt(clearReminderDrafts); await attempt(clearReminderOutbox); await attempt(() => clearCachedReminderSnapshots(isCurrent));
  await attempt(() => clearPersistedEncryption(isCurrent));
  await attempt(() => window.dispatchEvent(new StorageEvent('storage', { key: AUTH_TOKEN_KEY, oldValue: reminders, newValue: null })));
  const network = (await remote).some(result => result.status === 'rejected') || credentialsUnavailable;
  return failed ? 'Some browser data could not be cleared. Clear this site’s data in browser settings and revoke its sessions in Obsidian.' : network ? 'Logged out locally. Revoke this browser’s sessions in Obsidian to finish remote cleanup.' : null;
}
