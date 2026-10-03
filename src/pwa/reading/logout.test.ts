import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { renderHook } from '../../test/react-hooks';
import { usePwaSessionLifecycle } from '../hooks/usePwaSessionLifecycle';
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
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

function lifecycle() {
  const reportError = vi.fn(), showToast = vi.fn();
  const noop = () => {};
  const apiFetch = vi.fn(async (path: string, init?: RequestInit) => fetch(path, { ...init, headers: { Authorization: 'Bearer valid-reminders-token' } }));
  const options = { apiFetch, resetView: vi.fn(), disablePushNotifications: async () => {}, handleUnauthorizedRef: { current: noop },
    setAuthToken: noop, setConfig: noop, reportError, setSettingsOpen: noop, showToast };
  const hook = renderHook(() => usePwaSessionLifecycle(options), () => vi.stubGlobal('Event', window.Event));
  return { hook, reportError, options };
}

it.each(['malformed credentials', 'unavailable credential reads'])('app logout clears both features despite %s', async failure => {
  if (failure === 'unavailable credential reads') vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('Storage blocked'); });
  const current = capturePwaSession();
  const test = lifecycle();
  await act(async () => { await test.hook.current.logOut(); });
  expect(current()).toBe(false);
  expect(clearReadingData).toHaveBeenCalledOnce();
  expect(resetPwaEncryption).toHaveBeenCalledWith(true);
  expect(clearEncryptionSessionMarkers).toHaveBeenCalledOnce();
  expect(clearPersistedEncryption).toHaveBeenCalledOnce();
  expect(clearReminderDrafts).toHaveBeenCalledOnce();
  expect(clearReminderOutbox).toHaveBeenCalledOnce();
  expect(clearCachedReminderSnapshots).toHaveBeenCalledOnce();
  expect(test.options.resetView).toHaveBeenCalledOnce();
  expect(test.reportError).toHaveBeenLastCalledWith(expect.stringMatching(/could not|cannot/i));
  if (failure === 'malformed credentials') {
    expect(localStorage.getItem(AUTH_TOKEN_KEY)).toBeNull();
    const call = vi.mocked(fetch).mock.calls[0];
    expect(call?.[0]).toBe('/auth/session');
    expect(new Headers(call?.[1]?.headers).get('Authorization')).toBe('Bearer valid-reminders-token');
  }
});

it('reports incomplete erasure when removing encryption keys fails', async () => {
  vi.mocked(clearPersistedEncryption).mockRejectedValueOnce(new Error('Blocked database'));
  const test = lifecycle();
  await act(async () => { await test.hook.current.logOut(); });
  expect(test.reportError).toHaveBeenLastCalledWith(expect.stringContaining('could not be removed'));
  expect(clearReminderOutbox).toHaveBeenCalledOnce();
});

it('revokes a Reading-only connection without attempting a missing app credential', async () => {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.setItem(READING_SESSION_KEY, JSON.stringify({ token: 'reading-only', id: 'device', folderPath: 'Reading', generation: 'one', expiresAt: 1 }));
  const test = lifecycle();
  await act(async () => { await test.hook.current.logOut(); });
  expect(test.options.apiFetch).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledOnce();
  expect(new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer reading-only');
  expect(test.reportError).toHaveBeenLastCalledWith(null);
});
