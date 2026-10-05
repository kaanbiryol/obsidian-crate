import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { useReadingConnection } from './useReadingConnection';
import { useReadingSession } from './useReadingSession';
import { AUTH_TOKEN_KEY, PWA_LOGOUT_KEY } from '../config';
import { READING_SESSION_KEY, readReadingCache, readReadingDraft, writeValue, type ReadingSession } from './storage';
import { connectReadingFromReminders } from './api';
import { invalidatePwaSession } from '../session-generation';
import { prepareReadingEncryption } from './encryption-session';

vi.mock('./encryption-session', () => ({ prepareReadingEncryption: vi.fn(async () => null), resetReadingEncryption: vi.fn(), readingEncryptionHeaders: () => ({}), onReadingEncryptionReset: vi.fn() }));
vi.mock('../api', () => ({ registerPwaServiceWorker: vi.fn(async () => null) }));
vi.mock('./api', async importOriginal => ({
  ...await importOriginal<typeof import('./api')>(), connectReadingFromReminders: vi.fn(async () => null),
}));
vi.mock('./storage', async importOriginal => ({
  ...await importOriginal<typeof import('./storage')>(),
  readReadingCache: vi.fn(async () => undefined), pendingReading: vi.fn(async () => []),
  readReadingDraft: vi.fn(async () => undefined), hasEarlierReadingChanges: vi.fn(async () => false),
  writeValue: vi.fn(async () => {}),
}));

const session: ReadingSession = { token: 'enrolled-token', id: 'enrolled-session', folderPath: 'Reading', generation: 'one', expiresAt: 1 };
const replacement = { ...session, token: 'replacement-token', id: 'replacement-session' };
const values = new Map<string, string>();
const network = vi.fn<typeof fetch>();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  values.clear(); vi.clearAllMocks(); network.mockReset();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('location', { hash: '#reading=grant', href: 'https://example.test/notifications?section=reading#reading=grant' });
  vi.stubGlobal('history', { replaceState: vi.fn() });
  vi.stubGlobal('fetch', network);
});
function renderSession() {
  return renderHook(() => useReadingSession(useReadingConnection(true, true)), () => {
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) });
    document.cookie = '';
  });
}
function start() {
  const exchange = deferred<Response>();
  network.mockImplementationOnce(() => exchange.promise).mockResolvedValue(new Response(null, { status: 204 }));
  return { rendered: renderSession(), release: exchange.resolve };
}

describe('Reading enrollment authority', () => {
  it.each(['replacement', 'reset', 'unmount'] as const)('rejects stale state publications after %s', async change => {
    const h = start();
    await act(async () => { h.release(new Response(JSON.stringify(session))); });
    const publisher = h.rendered.current;
    expect(publisher.isCurrentSession(session)).toBe(true);
    await act(async () => {
      if (change === 'replacement') localStorage.setItem(READING_SESSION_KEY, JSON.stringify(replacement));
      if (change === 'reset') publisher.resetSession();
    });
    if (change === 'unmount') h.rendered.unmount();
    const before = h.rendered.current;
    await act(async () => {
      expect(publisher.publishPending(session, [{ id: 'stale', sessionId: session.id, action: 'retry', intent: { id: 'article' } }])).toBe(false);
      expect(publisher.publishSyncResult(session, { pending: [], cache: { items: [], issues: [], savedAt: 99 }, completed: true })).toBe(false);
      expect(publisher.finishCapture(session)).toBe(false);
      publisher.reportSessionError(session, 'A stale failure');
    });
    expect(h.rendered.current).toMatchObject({ cache: before.cache, pending: before.pending, error: before.error, url: before.url });
  });

  it('persists enrollment, hydrates a saved draft, and saves edits after rerender', async () => {
    vi.mocked(readReadingDraft).mockResolvedValueOnce({ url: 'https://saved.example/article' });
    const h = start();
    await act(async () => { h.release(new Response(JSON.stringify({ ...session, installToken: 'install-token' }))); });
    expect(JSON.parse(localStorage.getItem(READING_SESSION_KEY)!)).toEqual(session);
    expect(h.rendered.current).toMatchObject({ ready: true, session, adding: true, url: 'https://saved.example/article' });
    expect(document.cookie).toContain('crate-reading-install=install-token');
    expect(network).toHaveBeenCalledOnce();
    await act(async () => h.rendered.current.setUrl('https://edited.example/article'));
    expect(writeValue).toHaveBeenLastCalledWith(`draft:${session.id}`, { url: 'https://edited.example/article' }, session);
  });

  it.each(['peer logout', 'local logout', 'replacement reading session', 'replacement reminders session', 'reset', 'unmount'] as const)(
    'discards a delayed grant after %s', async change => {
      const h = start();
      await act(async () => {
        if (change === 'peer logout') localStorage.setItem(PWA_LOGOUT_KEY, 'logout');
        if (change === 'local logout') invalidatePwaSession();
        if (change === 'replacement reading session') localStorage.setItem(READING_SESSION_KEY, JSON.stringify(replacement));
        if (change === 'replacement reminders session') localStorage.setItem(AUTH_TOKEN_KEY, 'replacement-reminders');
        if (change === 'reset') h.rendered.current.resetSession();
      });
      if (change === 'unmount') h.rendered.unmount();
      await act(async () => { h.release(new Response(JSON.stringify({ ...session, installToken: 'obsolete-install-token' }))); });
      const revocation = network.mock.calls.find(([path]) => path === '/auth/session')![1]!;
      expect(revocation.method).toBe('DELETE');
      expect(new Headers(revocation.headers).get('Authorization')).toBe(`Bearer ${session.token}`);
      if (change !== 'unmount') expect(h.rendered.current.ready).toBe(true);
      expect(localStorage.getItem(READING_SESSION_KEY)).toBe(change === 'replacement reading session' ? JSON.stringify(replacement) : null);
      expect(readReadingCache).not.toHaveBeenCalled();
      expect(h.rendered.current.session).toBeNull();
      expect(document.cookie).not.toContain('obsolete-install-token');
    },
  );

  it('ignores a late enrollment failure after logout', async () => {
    const h = start();
    localStorage.setItem(PWA_LOGOUT_KEY, 'logout');
    await act(async () => { h.release(new Response(JSON.stringify({ error: 'Expired grant' }), { status: 401 })); });
    expect(h.rendered.current).toMatchObject({ ready: true, session: null, error: null });
    expect(localStorage.getItem(READING_SESSION_KEY)).toBeNull();
  });

  it('fences delayed hydration after reset and preserves an unreadable draft', async () => {
    const cache = deferred<undefined>();
    vi.mocked(readReadingCache).mockReturnValueOnce(cache.promise);
    const h = start();
    await act(async () => { h.release(new Response(JSON.stringify(session))); });
    await act(async () => h.rendered.current.resetSession());
    await act(async () => { cache.resolve(undefined); });
    expect(h.rendered.current.session).toBeNull();
    expect(writeValue).not.toHaveBeenCalled();
    h.rendered.unmount();

    vi.mocked(readReadingDraft).mockRejectedValueOnce(new Error('Saved draft needs recovery'));
    const damaged = start();
    await act(async () => { damaged.release(new Response(JSON.stringify(session))); });
    expect(damaged.rendered.current).toMatchObject({ session, recovery: true, error: 'Saved draft needs recovery' });
    expect(writeValue).not.toHaveBeenCalled();
  });

  it('does not restore a connection when encryption finishes after reset', async () => {
    const encryption = deferred<null>();
    vi.mocked(prepareReadingEncryption).mockReturnValueOnce(encryption.promise);
    const h = start();
    await act(async () => { h.release(new Response(JSON.stringify(session))); });
    await act(async () => h.rendered.current.resetSession());
    await act(async () => encryption.resolve(null));
    expect(h.rendered.current.session).toBeNull();
    expect(readReadingCache).not.toHaveBeenCalled();
  });

  it('removes connection listeners after enrollment and on unmount', async () => {
    vi.stubGlobal('location', { hash: '', href: 'https://example.test/notifications?section=reading' });
    localStorage.setItem(AUTH_TOKEN_KEY, 'reminders');
    const rendered = renderSession();
    await act(async () => {});
    expect(connectReadingFromReminders).toHaveBeenCalledOnce();
    vi.mocked(connectReadingFromReminders).mockImplementationOnce(async () => {
      localStorage.setItem(READING_SESSION_KEY, JSON.stringify(session)); return session;
    });
    await act(async () => window.dispatchEvent(new window.Event('online')));
    expect(rendered.current.session).toEqual(session);
    vi.mocked(connectReadingFromReminders).mockClear();
    await act(async () => window.dispatchEvent(new window.Event('online')));
    expect(connectReadingFromReminders).not.toHaveBeenCalled();
    rendered.unmount();
    window.dispatchEvent(new window.Event('online'));
    expect(connectReadingFromReminders).not.toHaveBeenCalled();
  });
});
