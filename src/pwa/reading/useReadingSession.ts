import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReadingConnection } from './useReadingConnection';
import type { PendingReading } from './outbox';
import { assertReadingSession, hasEarlierReadingChanges, pendingReading, readReadingCache, readReadingDraft, writeValue, type ReadingCache, type ReadingSession } from './storage';

/** Feature-owned durable hydration. Authentication and unlocking belong to the app. */
export function useReadingSession(connection: ReadingConnection) {
  const [session, setSession] = useState<ReadingSession | null>(null);
  const [hydrated, setHydrated] = useState<ReadingSession | null>(null);
  const [cache, setCache] = useState<ReadingCache | null>(null), [pending, setPending] = useState<PendingReading[]>([]);
  const [error, setError] = useState<string | null>(null), [storageError, setStorageError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState(false), [draftReady, setDraftReady] = useState(false);
  const [adding, setAdding] = useState(false), [url, setUrl] = useState(''), [share, setShare] = useState<string | null>(null);
  const alive = useRef(true), generation = useRef(0);
  const run = useCallback(async (action: () => Promise<void>) => {
    const revision = generation.current;
    try { await action(); } catch (cause) {
      if (alive.current && revision === generation.current) setError(cause instanceof Error ? cause.message : 'Reading is unavailable.');
    }
  }, []);
  const resetConnection = connection.resetSession;
  const resetSession = useCallback(() => {
    generation.current++; resetConnection();
    setSession(null); setHydrated(null); setCache(null); setPending([]); setDraftReady(false); setStorageError(null);
    setUrl(''); setAdding(false); setShare(null);
  }, [resetConnection]);
  useEffect(() => {
    // A null session during unlock is not a disconnected session. Scanning here
    // treats this session's encrypted queue as unreadable earlier-session work.
    if (!connection.ready || connection.connecting || connection.lockedSession) return;
    alive.current = true;
    const lifetime = generation;
    const revision = ++lifetime.current;
    const current = connection.session;
    setSession(null); setHydrated(null); setCache(null); setPending([]); setDraftReady(false); setStorageError(null);
    setUrl(''); setAdding(false); setShare(null); setError(null);
    const currentRequest = () => {
      if (!alive.current || revision !== generation.current) return false;
      if (current) assertReadingSession(current);
      return true;
    };
    void run(async () => {
      if (!current) {
        const earlier = await hasEarlierReadingChanges();
        if (currentRequest()) setRecovery(earlier);
        return;
      }
      // Read each lifetime separately: a disposable cache failure must not hide a
      // saved draft, and an unreadable draft must never be replaced by empty input.
      const results = await Promise.allSettled([
        readReadingCache(current), pendingReading(current), readReadingDraft(`draft:${current.id}`), hasEarlierReadingChanges(current.id),
      ]);
      if (!currentRequest()) return;
      const [saved, work, draft, earlier] = results;
      setCache(saved.status === 'fulfilled' ? saved.value ?? null : null);
      setPending(work.status === 'fulfilled' ? work.value : []);
      setRecovery(earlier.status === 'fulfilled' ? earlier.value : true);
      if (saved.status === 'rejected') setError(saved.reason instanceof Error ? saved.reason.message : 'The saved Reading library could not be read.');
      const failure = [work, draft, earlier].find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') {
        setStorageError(failure.reason instanceof Error ? failure.reason.message : 'Reading storage could not be read. Export your Reading data before changing browser storage.');
        setRecovery(true);
      }
      setSession(current);
      if (draft.status === 'fulfilled') {
        if (draft.value?.url) { setUrl(draft.value.url); setAdding(true); }
        setDraftReady(true);
      }

      if (!currentRequest()) return;
      setHydrated(current);
      const shareId = new URL(location.href).searchParams.get('share');
      if (shareId) {
        const draft = await readReadingDraft(`share:${shareId}`);
        if (currentRequest() && draft) { setUrl(draft.url); setAdding(true); setShare(shareId); }
      }
    });
    return () => { alive.current = false; lifetime.current++; };
  }, [connection.session, connection.ready, connection.connecting, connection.lockedSession, run]);
  const ready = connection.ready && (!connection.session || hydrated === connection.session || Boolean(error));
  useEffect(() => {
    if (session && ready && draftReady) void run(() => writeValue(`draft:${session.id}`, { url }, session));
  }, [session, ready, draftReady, url, run]);
  return { ...connection, session, ready, resetSession, cache, setCache, pending, setPending,
    error: storageError ?? error ?? connection.error, setError, recovery, adding, setAdding, url, setUrl, share, setShare, alive, run };
}
