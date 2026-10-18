import { drainReading, readingRetryAt, type ReadingRetryMode } from './outbox';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AUTH_TOKEN_KEY, PWA_AUTH_CHANGED_EVENT, PWA_LOGOUT_KEY } from '../config';
import { connectReadingFromReminders, loadReading } from './api';
import { assertReadingSession, pendingReading, readingLock, readingSession, readReadingCache, READING_SESSION_KEY, type ReadingCache, type ReadingSession } from './storage';
import type { useReadingSession } from './useReadingSession';
import { requestSharedFeaturesRefresh } from '../shared-features';

/** Owns refresh serialization, bounded retries and foreground/cross-tab refresh. */
export function useReadingSync({ session, ready, pending, publishSyncResult, isCurrentSession, run, resetSession }: Pick<ReturnType<typeof useReadingSession>,
  'session' | 'ready' | 'pending' | 'publishSyncResult' | 'isCurrentSession' | 'run' | 'resetSession'>, enabled = true) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const [syncing, setSyncing] = useState(false), [syncedSession, setSyncedSession] = useState<ReadingSession | null>(null);
  const [isOffline, setIsOffline] = useState(() => !navigator.onLine);
  const refreshing = useRef(false), refreshQueued = useRef<{ session: ReadingSession; mode: ReadingRetryMode } | null>(null);
  // The last confirmed library, so a conditional reload can keep it without decoding storage.
  const confirmedCache = useRef<{ session: ReadingSession; cache: ReadingCache } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    const changed = () => { setIsOffline(!navigator.onLine); setSyncedSession(null); };
    window.addEventListener('online', changed); window.addEventListener('offline', changed);
    return () => { window.removeEventListener('online', changed); window.removeEventListener('offline', changed); };
  }, []);
  const refresh = useCallback(async (current = session, mode: ReadingRetryMode = 'automatic') => {
    if (!current || !enabledRef.current || !isCurrentSession(current)) return;
    if (refreshing.current) {
      const queued = refreshQueued.current;
      const sameSession = queued?.session.id === current.id && queued.session.token === current.token && queued.session.generation === current.generation;
      refreshQueued.current = { session: current, mode: sameSession && queued.mode === 'manual' ? 'manual' : mode };
      return;
    }
    refreshing.current = true; setSyncing(true); setSyncedSession(null);
    requestSharedFeaturesRefresh();
    try {
      // Enrollment checks share the refresh lock. Foreground and cross-tab
      // events can arrive together while the previous check is still pending.
      if (current.source === 'reminders' && navigator.onLine) {
        const connected = await connectReadingFromReminders();
        if (!isCurrentSession(current)) return;
        if (!connected || connected.id !== current.id || connected.token !== current.token || connected.generation !== current.generation) {
          resetSession(); return;
        }
        if (!enabledRef.current) return;
      }
      let data: ReadingCache | undefined;
      let completed = false;
      try {
        const confirmed = await drainReading(current, mode, () => enabledRef.current);
        if (confirmed) data = confirmed;
        else if (navigator.onLine && enabledRef.current) {
          const previous = confirmedCache.current?.session === current ? confirmedCache.current.cache : await readReadingCache(current).catch(() => undefined);
          data = await loadReading(current, previous);
        } else data = await readReadingCache(current);
        if (data) confirmedCache.current = { session: current, cache: data };
        completed = true;
      } finally {
        // Publish the latest durable queue even when refreshing the list fails.
        // Queue edits and this read share a lock so a stale refresh cannot hide new work.
        await readingLock(async () => {
          const work = await pendingReading(current);
          assertReadingSession(current);
          if (!publishSyncResult(current, { pending: work, cache: data, completed })) return;
          if (completed && enabledRef.current && navigator.onLine && data) setSyncedSession(current);
        });
      }
    } finally {
      refreshing.current = false;
      if (mounted.current) setSyncing(false);
      const queued = refreshQueued.current;
      refreshQueued.current = null;
      if (queued && isCurrentSession(queued.session)) void run(() => refresh(queued.session, queued.mode));
    }
  }, [session, run, isCurrentSession, publishSyncResult, resetSession]);
  const retryAt = Math.min(...pending.map(op => readingRetryAt(op) ?? Infinity));
  useEffect(() => {
    if (!enabled || !session || !ready || isOffline || !Number.isFinite(retryAt)) return;
    // Match Reminders' short, bounded retries for interrupted requests. Their
    // exact persisted bodies remain authoritative until a receipt is confirmed.
    // Subscribe to the deadline, not queue object identity: a failed session/list
    // read must not repeatedly reschedule an already elapsed retry.
    const timer = window.setTimeout(() => { void run(() => refresh(session)); }, Math.max(0, retryAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [enabled, session, ready, isOffline, retryAt, refresh, run]);
  useEffect(() => {
    if (!session || !ready) return;
    const reload = () => { if (enabledRef.current && document.visibilityState === 'visible') void run(() => refresh(session)); };
    const changed = () => {
      let current: ReadingSession | null;
      try { current = readingSession(); } catch (cause) {
        resetSession(cause instanceof Error ? cause.message : 'Reading sign-in could not be read. Reconnect from Obsidian settings.');
        return;
      }
      if (current?.id !== session.id || current.generation !== session.generation || current.token !== session.token) resetSession();
      else reload();
    };
    const storageChanged = (event: StorageEvent) => {
      if (event.key === AUTH_TOKEN_KEY || event.key === READING_SESSION_KEY || event.key === PWA_LOGOUT_KEY || event.key === null) changed();
    };
    reload();
    // Refresh on open, foreground, reconnect and explicit refresh; never on a timer.
    window.addEventListener('online', reload); window.addEventListener('storage', storageChanged); window.addEventListener('crate-reading-change', changed); window.addEventListener(PWA_AUTH_CHANGED_EVENT, changed); document.addEventListener('visibilitychange', reload);
    return () => { window.removeEventListener('online', reload); window.removeEventListener('storage', storageChanged); window.removeEventListener('crate-reading-change', changed); window.removeEventListener(PWA_AUTH_CHANGED_EVENT, changed); document.removeEventListener('visibilitychange', reload); };
  }, [enabled, session, ready, refresh, run, resetSession]);
  const refreshManually = useCallback(() => refresh(session, 'manual'), [refresh, session]);
  return { refresh, refreshManually, syncing, syncedSession, isOffline };
}
