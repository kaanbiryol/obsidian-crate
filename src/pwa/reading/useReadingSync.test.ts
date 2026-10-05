import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderHook } from '../../test/react-hooks';
import { PWA_AUTH_CHANGED_EVENT } from '../config';
import { ReadingApiError, loadReading, readingRequest } from './api';
import type { ReadingCache, ReadingSession } from './storage';
import type { PendingReading } from './outbox';
import { useReadingSync } from './useReadingSync';
import { useReadingSession } from './useReadingSession';
import type { ReadingConnection } from './useReadingConnection';

const stored = vi.hoisted(() => ({ queue: [] as PendingReading[], session: null as ReadingSession | null, sessionError: null as Error | null }));
vi.mock('./api', async importOriginal => ({
  ...await importOriginal<typeof import('./api')>(), readingRequest: vi.fn(), loadReading: vi.fn(), connectReadingFromReminders: vi.fn(),
}));
vi.mock('./storage', async importOriginal => ({
  ...await importOriginal<typeof import('./storage')>(),
  assertReadingSession: (session: ReadingSession) => { if (stored.session !== session) throw new Error('Session changed'); },
  readingSession: () => { if (stored.sessionError) throw stored.sessionError; return stored.session; },
  readingLock: async <T>(action: () => Promise<T>) => action(),
  readingDrainLock: async <T>(action: () => Promise<T>) => action(),
  pendingReading: async () => structuredClone(stored.queue),
  readReadingCache: async () => cache,
  readReadingDraft: async () => undefined,
  hasEarlierReadingChanges: async () => false,
  writeValue: async (key: string, value: PendingReading[]) => { if (key.startsWith('pending:')) stored.queue = structuredClone(value); },
}));
const session: ReadingSession = { id: 'session', token: 'token', generation: 'one', folderPath: 'Reading', expiresAt: 1 };
const cache: ReadingCache = { items: [], issues: [], savedAt: 1 };
const resetSession = vi.fn();
const connection: ReadingConnection = { session, ready: true, lockedSession: null, encryptionSetupRequired: false,
  converting: false, expire: vi.fn(), connecting: false, connect: vi.fn(), resetSession, issue: null, error: null, connectionState: 'available' };
function renderSync(enabled = () => true) {
  return renderHook(() => {
    const state = useReadingSession(connection);
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
  vi.mocked(loadReading).mockResolvedValue(cache);
  vi.mocked(readingRequest).mockImplementation(async path => {
    if (path === '/reading/session') return { generation: session.generation, day: 20_000 };
    throw new ReadingApiError('Unavailable', 503);
  });
});
afterEach(() => vi.useRealTimers());
const sent = () => vi.mocked(readingRequest).mock.calls.filter(([path]) => path === '/reading/update');

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
    window.dispatchEvent(new window.Event('storage'));
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
