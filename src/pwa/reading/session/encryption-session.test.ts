import { afterEach, expect, it, vi } from 'vitest';
import { prepareReadingEncryption } from './encryption-session';
import { resetReadingEncryption } from './encryption-lifecycle';
import { consumeReadingKeyFragment, pendingReadingKey } from '../../encryption/encryption-fragments';
import { readingRequest } from '../api';
import { decodeReadingValue, encodeReadingValue } from '../storage/private-storage';
import { READING_SESSION_KEY, type ReadingSession } from './session';

afterEach(() => { resetReadingEncryption(true); vi.unstubAllGlobals(); });
function storage(): Storage {
  const values: Record<string, string> = {};
  return Object.defineProperties(values, {
    length: { get: () => Object.keys(values).length }, key: { value: (i: number) => Object.keys(values)[i] ?? null },
    getItem: { value: (k: string) => values[k] ?? null }, setItem: { value: (k: string, v: string) => { values[k] = v; } },
    removeItem: { value: (k: string) => { delete values[k]; } }, clear: { value: () => { for (const k of Object.keys(values)) delete values[k]; } },
  }) as unknown as Storage;
}
it('rechecks plaintext Reading before sending a new URL after another device enables encryption', async () => {
  vi.stubGlobal('localStorage', storage()); vi.stubGlobal('navigator', { onLine: true });
  const session: ReadingSession = { id: 'session', token: 'token', folderPath: 'Reading', generation: 'policy', expiresAt: Date.now() + 86400_000 };
  localStorage.setItem(READING_SESSION_KEY, JSON.stringify(session));
  let encrypted = false;
  const sent: Array<RequestInit['body']> = [];
  const request = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === '/reading/encryption') return encrypted
      ? Response.json({ error: 'Old enrollment was revoked by encryption' }, { status: 401 })
      : Response.json({ encryption: null });
    if (options?.body) sent.push(options.body);
    return Response.json({ error: 'Encryption required' }, { status: 428 });
  });
  vi.stubGlobal('fetch', request);
  expect(await prepareReadingEncryption(session)).toBeNull();
  encrypted = true;
  await expect(readingRequest('/reading/capture', session, JSON.stringify({ url: 'https://private.example/article' }))).rejects.toThrow();
  expect(sent).toEqual([]);
  expect(() => encodeReadingValue('pending:session', [])).toThrow();
});

it('checks plaintext Reading once for reads and again before each plaintext body', async () => {
  vi.stubGlobal('localStorage', storage()); vi.stubGlobal('navigator', { onLine: true });
  const session: ReadingSession = { id: 'session', token: 'token', folderPath: 'Reading', generation: 'policy', expiresAt: Date.now() + 86400_000 };
  localStorage.setItem(READING_SESSION_KEY, JSON.stringify(session));
  const request = vi.fn(async (path: string) => path === '/reading/encryption' ? Response.json({ encryption: null }) : Response.json({ items: [] }));
  vi.stubGlobal('fetch', request);
  const probes = () => request.mock.calls.filter(([path]) => path === '/reading/encryption').length;
  for (const path of ['/reading/list', '/reading/list?cursor=next', '/reading/item?id=a', '/reading/item?id=b']) await readingRequest(path, session);
  expect(probes()).toBe(1);
  await readingRequest('/reading/update', session, '{}');
  expect(probes()).toBe(2);
});

// Intended difference from reminders (see reminders/encryption-session.ts): Reading keeps
// verified access on EncryptionVerificationUnavailableError, while reminders lock.
it('keeps verified local Reading edits available when encryption verification loses the network', async () => {
  vi.stubGlobal('localStorage', storage()); vi.stubGlobal('navigator', { onLine: true });
  const session: ReadingSession = { id: 'session', token: 'token', folderPath: 'Reading', generation: 'policy', expiresAt: Date.now() + 86400_000 };
  localStorage.setItem(READING_SESSION_KEY, JSON.stringify(session));
  const request = vi.fn().mockResolvedValueOnce(Response.json({ encryption: null })).mockRejectedValue(new TypeError('Failed to fetch'));
  vi.stubGlobal('fetch', request);
  await prepareReadingEncryption(session);
  const key = 'pending:session', draft = [{ note: 'Saved locally' }];
  const stored = encodeReadingValue(key, draft);
  await expect(readingRequest('/reading/update', session, '{}')).rejects.toThrow('Could not verify encryption');
  expect(decodeReadingValue(key, stored)).toEqual(draft);
  expect(encodeReadingValue(key, draft)).toEqual(stored);
  expect(request.mock.calls.every(([path]) => path === '/reading/encryption')).toBe(true);
});

it('keeps unverified Reading storage locked after a network failure', async () => {
  vi.stubGlobal('localStorage', storage()); vi.stubGlobal('navigator', { onLine: true });
  const session: ReadingSession = { id: 'session', token: 'token', folderPath: 'Reading', generation: 'policy', expiresAt: Date.now() + 86400_000 };
  localStorage.setItem(READING_SESSION_KEY, JSON.stringify(session));
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  await expect(prepareReadingEncryption(session)).rejects.toThrow('Could not verify encryption');
  expect(() => encodeReadingValue('pending:session', [])).toThrow('Could not verify encryption');
});

it('keeps this link\'s Reading key through sign-in and forgets it on logout', () => {
  vi.stubGlobal('window', { location: { pathname: '/notifications', search: '', hash: '#crateReadingKey=code' },
    history: { state: null, replaceState: vi.fn() } });
  consumeReadingKeyFragment();
  resetReadingEncryption();
  expect(pendingReadingKey()).toBe('code');
  resetReadingEncryption(true);
  expect(pendingReadingKey()).toBeUndefined();
});
