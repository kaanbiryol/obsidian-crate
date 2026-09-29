import { drainReading, readingRetryAt, type ReadingRetryMode } from './outbox';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PWA_AUTH_CHANGED_EVENT } from '../config';
import { connectReadingFromReminders, loadReading } from './api';
import { assertReadingSession, pendingReading, readingLock, readingSession, readReadingCache, type ReadingCache, type ReadingSession } from './storage';
import type { useReadingSession } from './useReadingSession';

/** Owns refresh serialization, bounded retries and foreground/cross-tab refresh. */
export function useReadingSync({ session, ready, pending, setCache, setPending, setError, alive, run, resetSession }: Pick<ReturnType<typeof useReadingSession>,
  'session' | 'ready' | 'pending' | 'setCache' | 'setPending' | 'setError' | 'alive' | 'run' | 'resetSession'>) {
  const [syncing, setSyncing] = useState(false), [syncedSession, setSyncedSession] = useState<ReadingSession | null>(null);
  const [isOffline, setIsOffline] = useState(() => !navigator.onLine);
  const refreshing = useRef(false), refreshQueued = useRef<{ session: ReadingSession; mode: ReadingRetryMode } | null>(null);
  useEffect(() => {
    const changed = () => { setIsOffline(!navigator.onLine); setSyncedSession(null); };
    window.addEventListener('online', changed); window.addEventListener('offline', changed);
    return () => { window.removeEventListener('online', changed); window.removeEventListener('offline', changed); };
  }, []);
  const refresh = useCallback(async (current = session, mode: ReadingRetryMode = 'automatic') => {
    if (!current) return;
    if (refreshing.current) {
      const queued = refreshQueued.current;
      const sameSession = queued?.session.id === current.id && queued.session.token === current.token && queued.session.generation === current.generation;
      refreshQueued.current = { session: current, mode: sameSession && queued.mode === 'manual' ? 'manual' : mode };
      return;
    }
    refreshing.current = true; setSyncing(true); setSyncedSession(null);
    try {
      let data: ReadingCache | undefined;
      let completed = false;
      try {
        const confirmed = await drainReading(current, mode);
        data = navigator.onLine ? confirmed ?? await loadReading(current) : await readReadingCache(current);
        completed = true;
      } finally {
        // Publish the latest durable queue even when refreshing the list fails.
        // Queue edits and this read share a lock so a stale refresh cannot hide new work.
        await readingLock(async () => {
          const work = await pendingReading(current);
          assertReadingSession(current);
          if (!alive.current) return;
          if (data) {
            setCache(data);
          }
          setPending(work);
          if (completed) setError(null);
          if (completed && navigator.onLine && data) setSyncedSession(current);
        });
      }
    } finally {
      refreshing.current = false;
      if (alive.current) setSyncing(false);
      const queued = refreshQueued.current;
      refreshQueued.current = null;
      if (queued && alive.current) {
        const latest = readingSession();
        if (latest?.id === queued.session.id && latest.token === queued.session.token && latest.generation === queued.session.generation) void run(() => refresh(queued.session, queued.mode));
      }
    }
  }, [session, run, alive, setCache, setPending, setError]);
  const retryAt = Math.min(...pending.map(op => readingRetryAt(op) ?? Infinity));
  useEffect(() => {
    if (!session || !ready || isOffline || !Number.isFinite(retryAt)) return;
    // Match Reminders' short, bounded retries for interrupted requests. Their
    // exact persisted bodies remain authoritative until a receipt is confirmed.
    // Subscribe to the deadline, not queue object identity: a failed session/list
    // read must not repeatedly reschedule an already elapsed retry.
    const timer = window.setTimeout(() => { void run(() => refresh(session)); }, Math.max(0, retryAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [session, ready, isOffline, retryAt, refresh, run]);
  useEffect(() => {
    if (!session || !ready) return;
    const reload = () => { if (document.visibilityState === 'visible') void run(async () => {
      if (session.source === 'reminders' && navigator.onLine) {
        const current = await connectReadingFromReminders();
        if (!current || current.id !== session.id || current.generation !== session.generation) {
          resetSession(); return;
        }
      }
      await refresh(session);
    }); };
    const changed = () => { const current = readingSession(); if (current?.id !== session.id || current.generation !== session.generation || current.token !== session.token) { resetSession(); } else reload(); };
    reload();
    const timer = window.setInterval(reload, 30_000);
    window.addEventListener('online', reload); window.addEventListener('storage', changed); window.addEventListener('crate-reading-change', changed); window.addEventListener(PWA_AUTH_CHANGED_EVENT, changed); document.addEventListener('visibilitychange', reload);
    return () => { clearInterval(timer); window.removeEventListener('online', reload); window.removeEventListener('storage', changed); window.removeEventListener('crate-reading-change', changed); window.removeEventListener(PWA_AUTH_CHANGED_EVENT, changed); document.removeEventListener('visibilitychange', reload); };
  }, [session, ready, refresh, run, resetSession]);
  const refreshManually = useCallback(() => refresh(session, 'manual'), [refresh, session]);
  return { refresh, refreshManually, syncing, syncedSession, isOffline };
}
