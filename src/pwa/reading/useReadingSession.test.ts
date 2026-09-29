import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReadingSession } from './useReadingSession';
import { AUTH_TOKEN_KEY, PWA_LOGOUT_KEY } from '../config';
import { READING_SESSION_KEY, readReadingCache, type ReadingSession } from './storage';
import { invalidatePwaSession } from '../session-generation';

const hooks = vi.hoisted(() => ({ effects: [] as Array<() => (() => void) | undefined>, setters: [] as Array<ReturnType<typeof vi.fn>> }));
vi.mock('react', () => ({
  useCallback: (fn: unknown) => fn,
  useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => { const setter = vi.fn(); hooks.setters.push(setter); return [initial, setter]; },
  useEffect: (effect: () => (() => void) | undefined) => { hooks.effects.push(effect); },
}));
vi.mock('../api', () => ({ registerPwaServiceWorker: vi.fn(async () => null) }));
vi.mock('./storage', async importOriginal => ({
  ...await importOriginal<typeof import('./storage')>(),
  readReadingCache: vi.fn(async () => undefined), pendingReading: vi.fn(async () => []),
  readReadingDraft: vi.fn(async () => undefined), hasEarlierReadingChanges: vi.fn(async () => false),
}));

const session: ReadingSession = { token: 'enrolled-token', id: 'enrolled-session', folderPath: 'Reading', generation: 'one', expiresAt: 1 };
const replacement = { ...session, token: 'replacement-token', id: 'replacement-session' };
const values = new Map<string, string>();
const network = vi.fn<typeof fetch>();

beforeEach(() => {
  values.clear(); hooks.effects = []; hooks.setters = []; vi.clearAllMocks(); network.mockReset();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  vi.stubGlobal('document', { querySelector: () => null, cookie: '' });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('location', { hash: '#reading=grant', href: 'https://example.test/notifications?section=reading#reading=grant' });
  vi.stubGlobal('history', { replaceState: vi.fn() });
  vi.stubGlobal('fetch', network);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function start() {
  let release!: (value: Response) => void;
  network.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }))
    .mockResolvedValue(new Response(null, { status: 204 }));
  // eslint-disable-next-line react-hooks/rules-of-hooks -- Exercise the real hook with controlled React effects.
  const hook = useReadingSession();
  const cleanup = hooks.effects[0]!()!;
  return { hook, cleanup, release, ready: () => expect(hooks.setters[1]).toHaveBeenCalledWith(true) };
}

describe('Reading enrollment authority', () => {
  it('persists a current enrollment before hydrating its data', async () => {
    const h = start();
    h.release(new Response(JSON.stringify({ ...session, installToken: 'install-token' })));
    await vi.waitFor(h.ready);
    expect(JSON.parse(localStorage.getItem(READING_SESSION_KEY)!)).toEqual(session);
    expect(hooks.setters[0]).toHaveBeenCalledWith(session);
    expect(document.cookie).toContain('crate-reading-install=install-token');
    expect(network).toHaveBeenCalledOnce();
    h.cleanup();
  });

  it.each(['peer logout', 'local logout', 'replacement reading session', 'replacement reminders session', 'reset', 'unmount'] as const)(
    'discards a delayed grant after %s', async change => {
      const h = start();
      if (change === 'peer logout') localStorage.setItem(PWA_LOGOUT_KEY, 'logout');
      if (change === 'local logout') invalidatePwaSession();
      if (change === 'replacement reading session') localStorage.setItem(READING_SESSION_KEY, JSON.stringify(replacement));
      if (change === 'replacement reminders session') localStorage.setItem(AUTH_TOKEN_KEY, 'replacement-reminders');
      if (change === 'reset') h.hook.resetSession();
      if (change === 'unmount') h.cleanup();
      h.release(new Response(JSON.stringify({ ...session, installToken: 'obsolete-install-token' })));
      await vi.waitFor(() => expect(network.mock.calls.some(([path]) => path === '/auth/session')).toBe(true));
      const revocation = network.mock.calls.find(([path]) => path === '/auth/session')![1]!;
      expect(revocation.method).toBe('DELETE');
      expect(new Headers(revocation.headers).get('Authorization')).toBe(`Bearer ${session.token}`);
      if (change !== 'unmount') await vi.waitFor(h.ready);
      expect(localStorage.getItem(READING_SESSION_KEY)).toBe(change === 'replacement reading session' ? JSON.stringify(replacement) : null);
      expect(readReadingCache).not.toHaveBeenCalled();
      expect(hooks.setters[0]).not.toHaveBeenCalledWith(session);
      expect(document.cookie).not.toContain('obsolete-install-token');
      h.cleanup();
    },
  );

  it('ignores a late enrollment failure after logout', async () => {
    const h = start();
    localStorage.setItem(PWA_LOGOUT_KEY, 'logout');
    h.release(new Response(JSON.stringify({ error: 'Expired grant' }), { status: 401 }));
    await vi.waitFor(h.ready);
    expect(hooks.setters[5]).not.toHaveBeenCalled();
    expect(localStorage.getItem(READING_SESSION_KEY)).toBeNull();
    h.cleanup();
  });
});
