import { afterEach, expect, it, vi } from 'vitest';
import { prepareReadingEncryption } from './encryption-session';
import { resetReadingEncryption } from './encryption-lifecycle';
import { readingRequest } from './api';
import { READING_SESSION_KEY, type ReadingSession } from './storage';

afterEach(() => { resetReadingEncryption(); vi.unstubAllGlobals(); });
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
});
