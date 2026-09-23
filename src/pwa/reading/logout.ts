import { AUTH_TOKEN_KEY, PWA_LOGOUT_KEY, finishEnrollment } from '../config';
import { clearReminderDrafts } from '../reminder-drafts';
import { clearReminderOutbox } from '../reminder-outbox-storage';
import { clearCachedReminderSnapshots } from '../reminder-cache';
import { invalidatePwaSession } from '../session-generation';
import { clearReadingData, readingSession } from './storage';
import { CRATE_PROTOCOL_HEADER, CRATE_PLUGIN_PROTOCOL } from '@/protocol';

export async function logoutReadingApp(): Promise<string | null> {
  const reading = readingSession(), reminders = localStorage.getItem(AUTH_TOKEN_KEY);
  invalidatePwaSession();
  const remote = Promise.allSettled([...new Set([reading?.token, reminders].filter((token): token is string => !!token))].map(async token => {
    const response = await fetch('/auth/session', { method: 'DELETE', signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${token}`, [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current) } });
    if (!response.ok) throw new Error('Session revocation failed');
  }));
  let failed = false;
  const attempt = async (action: () => unknown) => { try { if (await action() === false) failed = true; } catch { failed = true; } };
  await attempt(() => localStorage.removeItem(AUTH_TOKEN_KEY));
  await attempt(() => localStorage.setItem(PWA_LOGOUT_KEY, crypto.randomUUID()));
  await attempt(() => finishEnrollment(false));
  document.cookie = 'crate-reading-install=; Max-Age=0; Path=/notifications; SameSite=Strict; Secure';
  await attempt(clearReadingData); await attempt(clearReminderDrafts); await attempt(clearReminderOutbox); await attempt(clearCachedReminderSnapshots);
  window.dispatchEvent(new StorageEvent('storage', { key: AUTH_TOKEN_KEY, newValue: null }));
  const network = (await remote).some(result => result.status === 'rejected');
  return failed ? 'Some browser data could not be cleared. Clear this site’s data in browser settings and revoke its sessions in Obsidian.' : network ? 'Logged out locally. Revoke this browser’s sessions in Obsidian to finish remote cleanup.' : null;
}
