import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { AUTH_TOKEN_KEY, PWA_AUTH_CHANGED_EVENT, PWA_LOGOUT_KEY } from '../config';
import { PWA_PREFERENCES_KEY } from '../settings/preferences';
import { ReadingApiError, connectReadingFromReminders, loadReading, readingRequest } from './api';
import { type ReadingCache } from './storage/storage';
import { READING_SESSION_KEY, type ReadingSession } from './session/session';
import type { PendingReading } from './outbox';
import { useReadingSync } from './useReadingSync';
import { prefetchReadingArticles } from './prefetch';
import { useReadingSession } from './useReadingSession';
import type { ReadingConnection } from './session/useReadingConnection';

const stored = vi.hoisted(() => ({ queue: [] as PendingReading[], session: null as ReadingSession | null, sessionError: null as Error | null }));
vi.mock('./api', async importOriginal => ({
  ...await importOriginal<typeof import('./api')>(), readingRequest: vi.fn(), loadReading: vi.fn(), connectReadingFromReminders: vi.fn(),
}));
vi.mock('./prefetch', () => ({ prefetchReadingArticles: vi.fn(async () => {}) }));
vi.mock('./session/session', async importOriginal => ({
  ...await importOriginal<typeof import('./session/session')>(),
  assertReadingSession: (session: ReadingSession) => { if (stored.session !== session) throw new Error('Session changed'); },
  readingSession: () => { if (stored.sessionError) throw stored.sessionError; return stored.session; },
}));
vi.mock('./storage/storage', async importOriginal => ({
  ...await importOriginal<typeof import('./storage/storage')>(),
  readingLock: async <T>(action: () => Promise<T>) => action(),
  readingDrainLock: async <T>(action: () => Promise<T>) => action(),
  pendingReading: async () => structuredClone(stored.queue),
  readReadingCache: async () => cache,
  readReadingDraft: async () => undefined,
  hasEarlierReadingChanges: async () => false,
  savePendingReading: async (_session: ReadingSession, value: PendingReading[]) => { stored.queue = structuredClone(value); },
  saveReadingDraft: async () => {},
}));
const session: ReadingSession = { id: 'session', token: 'token', generation: 'one', folderPath: 'Reading', expiresAt: 1 };
const cache: ReadingCache = { items: [], issues: [], savedAt: 1 };
const resetSession = vi.fn();
const connection: ReadingConnection = { session, ready: true, lockedSession: null, encryptionSetupRequired: false,
  converting: false, expire: vi.fn(), connecting: false, connect: vi.fn(), resetSession, issue: null, error: null, connectionState: 'available' };
function renderSync(enabled = () => true, currentConnection = connection) {
  return renderHook(() => {
    const state = useReadingSession(currentConnection);
    return { ...useReadingSync(state, enabled()), pending: state.pending, error: state.error };
  }, () => Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }));
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  stored.session = session;
  stored.sessionError = null;
  stored.queue = [{ id: 'operation', sessionId: session.id, action: 'update', intent: { id: 'article', changes: { favorite: true }, before: { favorite: false } } }];
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('location', { href: 'https://example.test/notifications' });
  vi.mocked(connectReadingFromReminders).mockImplementation(async () => stored.session);
  vi.mocked(loadReading).mockResolvedValue(cache);
  vi.mocked(readingRequest).mockImplementation(async path => {
    if (path === '/reading/session') return { generation: session.generation, day: 20_000 };
    throw new ReadingApiError('Unavailable', 503);
  });
});
afterEach(() => vi.useRealTimers());
const sent = () => vi.mocked(readingRequest).mock.calls.filter(([path]) => path === '/reading/update');
function storageChanged(key: string | null) {
  window.dispatchEvent(Object.assign(new window.Event('storage'), { key }));
}

it('saves offline copies after an online refresh, one run at a time', async () => {
  stored.queue = [];
  let finish!: () => void;
  vi.mocked(prefetchReadingArticles).mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const rendered = renderSync();
  await act(async () => {});
  expect(prefetchReadingArticles).toHaveBeenCalledExactlyOnceWith(session, cache.items, expect.any(Function));
  await act(async () => { await rendered.current.refresh(); });
  expect(prefetchReadingArticles).toHaveBeenCalledOnce();
  await act(async () => { finish(); });
  await act(async () => { await rendered.current.refresh(); });
  expect(prefetchReadingArticles).toHaveBeenCalledTimes(2);
  // The run stops once Reading is paused or the session changes.
  const isCurrent = vi.mocked(prefetchReadingArticles).mock.calls[0]![2];
  expect(isCurrent()).toBe(true);
  stored.session = null;
  expect(isCurrent()).toBe(false);
});

it('does not save offline copies from an offline refresh', async () => {
  stored.queue = [];
  vi.stubGlobal('navigator', { onLine: false });
  renderSync();
  await act(async () => {});
  expect(prefetchReadingArticles).not.toHaveBeenCalled();
});

it('ignores unrelated cross-tab preferences and reminder queue changes', async () => {
  const linked = { ...session, source: 'reminders' as const };
  stored.session = linked;
  stored.queue = [];
  renderSync(() => true, { ...connection, session: linked });
  await act(async () => {});
  vi.mocked(connectReadingFromReminders).mockClear();
  vi.mocked(loadReading).mockClear();
  vi.mocked(readingRequest).mockClear();
  await act(async () => {
    storageChanged(PWA_PREFERENCES_KEY);
    storageChanged('crate-reminder-outbox:another-operation');
  });
  expect(connectReadingFromReminders).not.toHaveBeenCalled();
  expect(readingRequest).not.toHaveBeenCalled();
  expect(loadReading).not.toHaveBeenCalled();
  expect(resetSession).not.toHaveBeenCalled();
});

it.each([AUTH_TOKEN_KEY, READING_SESSION_KEY, PWA_LOGOUT_KEY, null])('still invalidates removed credentials for storage key %s', async key => {
  const rendered = renderSync(() => false);
  await act(async () => {});
  stored.session = null;
  await act(async () => storageChanged(key));
  expect(resetSession).toHaveBeenCalledOnce();
  expect(rendered.current.syncedSession).toBeNull();
  expect(stored.queue).toHaveLength(1);
  expect(connectReadingFromReminders).not.toHaveBeenCalled();
  expect(readingRequest).not.toHaveBeenCalled();
});

it('coalesces event bursts throughout enrollment checks and list refreshes', async () => {
  const linked = { ...session, source: 'reminders' as const };
  stored.session = linked;
  stored.queue = [];
  const checks: Array<(value: ReadingSession | null) => void> = [];
  vi.mocked(connectReadingFromReminders).mockImplementation(() => new Promise(resolve => { checks.push(resolve); }));
  let releaseList!: (value: ReadingCache) => void;
  vi.mocked(loadReading).mockImplementationOnce(() => new Promise(resolve => { releaseList = resolve; }));
  const rendered = renderSync(() => true, { ...connection, session: linked });
  await act(async () => {});
  const events = () => {
    window.dispatchEvent(new window.Event('online'));
    document.dispatchEvent(new window.Event('visibilitychange'));
    storageChanged(READING_SESSION_KEY);
    window.dispatchEvent(new window.Event(PWA_AUTH_CHANGED_EVENT));
  };
  await act(async () => events());
  expect(connectReadingFromReminders).toHaveBeenCalledOnce();
  expect(loadReading).not.toHaveBeenCalled();
  await act(async () => { checks[0]!(linked); });
  expect(loadReading).toHaveBeenCalledOnce();
  await act(async () => events());
  expect(connectReadingFromReminders).toHaveBeenCalledOnce();
  await act(async () => { releaseList(cache); });
  expect(connectReadingFromReminders).toHaveBeenCalledTimes(2);
  expect(loadReading).toHaveBeenCalledOnce();
  await act(async () => { checks[1]!(linked); });
  expect(connectReadingFromReminders).toHaveBeenCalledTimes(2);
  expect(loadReading).toHaveBeenCalledTimes(2);
  expect(rendered.current.syncedSession).toBe(linked);
});

it.each(['paused', 'unmounted', 'replaced'])('does not act on a delayed enrollment check when %s', async state => {
  const linked = { ...session, source: 'reminders' as const };
  stored.session = linked;
  let release!: (value: ReadingSession | null) => void;
  vi.mocked(connectReadingFromReminders).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  let enabled = true;
  const rendered = renderSync(() => enabled, { ...connection, session: linked });
  await act(async () => {});
  await act(async () => rendered.current.refreshManually());
  if (state === 'paused') { enabled = false; rendered.rerender(); }
  else if (state === 'unmounted') rendered.unmount();
  else stored.session = { ...linked, token: 'replacement' };
  await act(async () => { release(state === 'replaced' ? null : linked); });
  expect(connectReadingFromReminders).toHaveBeenCalledOnce();
  expect(readingRequest).not.toHaveBeenCalled();
  expect(loadReading).not.toHaveBeenCalled();
  expect(resetSession).not.toHaveBeenCalled();
  expect(stored.queue).toHaveLength(1);
});

it('invalidates unreadable credentials during auth changes without throwing or deleting pending work', async () => {
  const rendered = renderSync(() => false);
  await act(async () => {});
  stored.sessionError = new Error('Reading sign-in could not be read.');
  await act(async () => { window.dispatchEvent(new window.Event(PWA_AUTH_CHANGED_EVENT)); });
  expect(resetSession).toHaveBeenCalledOnce();
  expect(rendered.current.error).toBe(stored.sessionError.message);
  expect(stored.queue).toHaveLength(1);
  expect(readingRequest).not.toHaveBeenCalled();
});

it('keeps every background trigger within the retry deadline and budget, allowing explicit retry', async () => {
  const rendered = renderSync();
  await act(async () => {});
  expect(sent()).toHaveLength(1);
  const original = stored.queue[0]!.body;
  await act(async () => {
    window.dispatchEvent(new window.Event('online'));
    storageChanged(READING_SESSION_KEY);
    document.dispatchEvent(new window.Event('visibilitychange'));
  });
  expect(sent()).toHaveLength(1);
  await act(async () => vi.advanceTimersByTimeAsync(1999));
  expect(sent()).toHaveLength(1);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(sent()).toHaveLength(2);
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(sent()).toHaveLength(3);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  await act(async () => window.dispatchEvent(new window.Event(PWA_AUTH_CHANGED_EVENT)));
  expect(sent()).toHaveLength(3);
  expect(rendered.current.pending[0]?.attempts).toBe(3);
  await act(async () => rendered.current.refreshManually());
  expect(sent()).toHaveLength(4);
  expect(sent().every(([, , body]) => body === original)).toBe(true);
  rendered.unmount();
  vi.mocked(readingRequest).mockClear(); vi.mocked(loadReading).mockClear();
  window.dispatchEvent(new window.Event('online'));
  document.dispatchEvent(new window.Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(readingRequest).not.toHaveBeenCalled();
  expect(loadReading).not.toHaveBeenCalled();
});

it('retains a queued manual retry when a background refresh arrives before the current refresh finishes', async () => {
  stored.queue[0] = { ...stored.queue[0]!, error: 'Unavailable', attempts: 3, retryAt: 1 };
  let release!: (cache: ReadingCache) => void;
  vi.mocked(loadReading).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const rendered = renderSync();
  await act(async () => {});
  await act(async () => rendered.current.refreshManually());
  await act(async () => window.dispatchEvent(new window.Event('online')));
  await act(async () => { release(cache); });
  expect(sent()).toHaveLength(1);
  expect(rendered.current.pending[0]?.attempts).toBe(4);
});

it('does not publish a delayed refresh or run its queued retry after unmount', async () => {
  let release!: (cache: ReadingCache) => void;
  vi.mocked(loadReading).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const rendered = renderSync();
  await act(async () => {});
  await act(async () => rendered.current.refreshManually());
  rendered.unmount();
  await act(async () => { release(cache); });
  expect(sent()).toHaveLength(1);
  expect(rendered.current.syncedSession).toBeNull();
});

it('keeps paused queues intact and resumes them without remounting a screen', async () => {
  let enabled = false;
  const rendered = renderSync(() => enabled);
  await act(async () => {});
  await act(async () => rendered.current.refreshManually());
  await act(async () => window.dispatchEvent(new window.Event('online')));
  expect(readingRequest).not.toHaveBeenCalled();
  expect(loadReading).not.toHaveBeenCalled();
  expect(stored.queue).toHaveLength(1);
  enabled = true; rendered.rerender();
  await act(async () => {});
  expect(sent()).toHaveLength(1);
});

it('does not start a mutation or list fetch when paused during a session check', async () => {
  let release!: (value: unknown) => void;
  vi.mocked(readingRequest).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  let enabled = true;
  const rendered = renderSync(() => enabled);
  await act(async () => {});
  enabled = false; rendered.rerender();
  await act(async () => { release({ generation: session.generation, day: 20_000 }); });
  expect(sent()).toHaveLength(0);
  expect(loadReading).not.toHaveBeenCalled();
  expect(stored.queue).toHaveLength(1);
  expect(rendered.current.error).toBeNull();
  expect(rendered.current.syncedSession).toBeNull();
});

it('refreshes the library on open and when shown again, never on a timer', async () => {
  stored.queue = [];
  renderSync();
  await act(async () => {});
  expect(loadReading).toHaveBeenCalledOnce();
  // Before: another full library load every 30 seconds while visible.
  await act(async () => vi.advanceTimersByTimeAsync(60 * 60_000));
  expect(loadReading).toHaveBeenCalledOnce();
  await act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
  expect(loadReading).toHaveBeenCalledTimes(2);
});

it('reuses a refresh completed within 30 seconds when shown again, but not when reconnecting', async () => {
  stored.queue = [];
  renderSync();
  await act(async () => {});
  expect(loadReading).toHaveBeenCalledOnce();
  // Before: every foreground reloaded the list in every tab.
  await act(async () => vi.advanceTimersByTimeAsync(29_999));
  await act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
  expect(loadReading).toHaveBeenCalledOnce();
  await act(async () => window.dispatchEvent(new window.Event('online')));
  expect(loadReading).toHaveBeenCalledTimes(2);
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  await act(async () => document.dispatchEvent(new window.Event('visibilitychange')));
  expect(loadReading).toHaveBeenCalledTimes(3);
});
