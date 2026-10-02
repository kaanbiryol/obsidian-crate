import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { addReminderScope, createReminderKeyGrant, createVaultKeyBundle } from '../encryption/key-bundle';
import { encodeWebAppKey } from '../encryption/web-app-key';
import { rememberWebAppKey } from './web-app-unlock';
import { rememberReminderKeys } from './encryption-keys';
import { AUTH_TOKEN_KEY, saveConfig } from './config';
import { READING_SESSION_KEY } from './reading/storage';
import type { ScopedEncryptionState } from './encryption-scope';
vi.mock('./encryption-keys', () => ({ rememberReminderKeys: vi.fn(async () => {}) }));

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.mocked(rememberReminderKeys).mockClear();
  localStorage.setItem(AUTH_TOKEN_KEY, 'reminders-session');
  saveConfig({ folderPath: 'Old reminders', upcomingDays: 7, allDayNotificationTime: null });
  localStorage.setItem(READING_SESSION_KEY, JSON.stringify({ token: 'reading-token', id: 'reading-session', folderPath: 'Old reading', generation: 'policy', expiresAt: Date.now() + 100000 }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function fixture(primary: 'Reminders' | 'Reading' = 'Reminders') {
  const bundle = addReminderScope(addReminderScope(createVaultKeyBundle(), 'Reminders'), 'Reading', 'reading');
  const grants = ['Reminders', 'Reading'].map(folder => createReminderKeyGrant(bundle, folder));
  const grant = grants.find(grant => grant.scope.folderPath === primary)!;
  const expected: ScopedEncryptionState = { version: 1, vaultId: bundle.vaultId, generation: bundle.generation, mode: 'active',
    scope: { id: grant.scope.id, folderPath: primary, purpose: grant.scope.purpose, keyId: grant.scope.data.id, notificationKeyId: grant.scope.notifications.id } };
  return { grants, expected, code: encodeWebAppKey(grants) };
}
it.each(['Reminders', 'Reading'] as const)('imports both folders from %s while preserving each original local namespace', async feature => {
  const f = fixture(feature);
  await rememberWebAppKey(f.code, f.expected, feature === 'Reading' ? 'Old reading' : 'Old reminders', () => true);
  expect(rememberReminderKeys).toHaveBeenCalledTimes(2);
  expect(rememberReminderKeys).toHaveBeenNthCalledWith(1, f.grants[0], expect.any(Function), 'Old reminders');
  expect(rememberReminderKeys).toHaveBeenNthCalledWith(2, f.grants[1], expect.any(Function), 'Old reading');
});
it('rejects another vault before persisting any keys', async () => {
  const f = fixture(); f.expected.vaultId = crypto.randomUUID();
  await expect(rememberWebAppKey(f.code, f.expected, 'Reminders', () => true)).rejects.toThrow('does not match');
  expect(rememberReminderKeys).not.toHaveBeenCalled();
});
it.each(['reminders', 'reading', 'caller'])('stops a stale import when the %s session changes', async feature => {
  const f = fixture(); let active = true;
  vi.mocked(rememberReminderKeys).mockImplementationOnce(async (_grant, current) => {
    if (feature === 'reminders') localStorage.setItem(AUTH_TOKEN_KEY, 'new-session');
    if (feature === 'reading') localStorage.removeItem(READING_SESSION_KEY);
    if (feature === 'caller') active = false;
    expect(current!()).toBe(false);
    throw new Error('Session changed');
  });
  await expect(rememberWebAppKey(f.code, f.expected, 'Reminders', () => active)).rejects.toThrow('Session changed');
  expect(rememberReminderKeys).toHaveBeenCalledOnce();
});
it('supports an enrollment for one feature without depending on sibling session data', async () => {
  const f = fixture(); localStorage.setItem(READING_SESSION_KEY, 'damaged');
  await rememberWebAppKey(encodeWebAppKey([f.grants[0]!]), f.expected, 'Reminders', () => true);
  expect(rememberReminderKeys).toHaveBeenCalledOnce();
});
