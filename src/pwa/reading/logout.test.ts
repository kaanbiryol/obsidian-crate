import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { logoutReadingApp } from './logout';
import { clearReadingData, READING_SESSION_KEY } from './storage';
import { AUTH_TOKEN_KEY } from '../config';
import { clearReminderDrafts } from '../reminder-drafts';
import { clearReminderOutbox } from '../reminder-outbox-storage';
import { clearCachedReminderSnapshots } from '../reminder-cache';
import { clearPersistedEncryption, clearEncryptionSessionMarkers } from '../encryption-cleanup';
import { resetPwaEncryption } from '../encryption-session';
import { capturePwaSession } from '../session-generation';

vi.mock('../encryption-cleanup', async importOriginal => ({ ...await importOriginal<typeof import('../encryption-cleanup')>(), clearPersistedEncryption: vi.fn(async () => {}), clearEncryptionSessionMarkers: vi.fn() }));
vi.mock('../encryption-session', () => ({ resetPwaEncryption: vi.fn() }));
vi.mock('./storage', async importOriginal => ({ ...await importOriginal<typeof import('./storage')>(), clearReadingData: vi.fn(async () => {}) }));
vi.mock('../config', async importOriginal => ({ ...await importOriginal<typeof import('../config')>(), finishEnrollment: vi.fn() }));
vi.mock('../reminder-drafts', () => ({ clearReminderDrafts: vi.fn(() => true) }));
vi.mock('../reminder-outbox-storage', () => ({ clearReminderOutbox: vi.fn() }));
vi.mock('../reminder-cache', () => ({ clearCachedReminderSnapshots: vi.fn(async () => true) }));

beforeEach(() => {
  const values = new Map([[READING_SESSION_KEY, '{ damaged credentials'], [AUTH_TOKEN_KEY, 'valid-reminders-token']]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal('document', { cookie: '' });
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
  vi.stubGlobal('StorageEvent', class extends Event {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it.each(['malformed credentials', 'unavailable credential reads'])('clears device data and fences in-flight work despite %s', async failure => {
  if (failure === 'unavailable credential reads') vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  const current = capturePwaSession();
  await expect(logoutReadingApp()).resolves.toContain(failure === 'unavailable credential reads' ? 'Some browser data could not be cleared' : 'Revoke this browser');
  expect(current()).toBe(false);
  expect(clearReadingData).toHaveBeenCalledOnce();
  expect(resetPwaEncryption).toHaveBeenCalledWith(true);
  expect(clearEncryptionSessionMarkers).toHaveBeenCalledOnce();
  expect(clearPersistedEncryption).toHaveBeenCalledOnce();
  expect(clearReminderDrafts).toHaveBeenCalledOnce();
  expect(clearReminderOutbox).toHaveBeenCalledOnce();
  expect(clearCachedReminderSnapshots).toHaveBeenCalledOnce();
  if (failure === 'malformed credentials') {
    expect(localStorage.getItem(AUTH_TOKEN_KEY)).toBeNull();
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call?.[0]).toBe('/auth/session');
    expect(new Headers(call?.[1]?.headers).get('Authorization')).toBe('Bearer valid-reminders-token');
  }
});

it('reports incomplete erasure when removing encryption keys fails', async () => {
  vi.mocked(clearPersistedEncryption).mockRejectedValueOnce(new Error('Blocked database'));
  await expect(logoutReadingApp()).resolves.toContain('Some browser data could not be cleared');
  expect(clearReminderOutbox).toHaveBeenCalledOnce();
});
