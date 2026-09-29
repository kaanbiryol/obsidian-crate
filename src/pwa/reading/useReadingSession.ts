import { useCallback, useEffect, useRef, useState } from 'react';
import { manifestHrefForUrl } from '@/cloudflare/worker/pwa/pwa-params';
import { PWA_ASSET_VERSION } from '@/cloudflare/worker/pwa-version';
import { registerPwaServiceWorker } from '../api';
import { AUTH_TOKEN_KEY, PWA_AUTH_CHANGED_EVENT, PWA_LOGOUT_KEY, isStandaloneApp } from '../config';
import { capturePwaSession } from '../session-generation';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol';
import { connectReadingFromReminders, readingRequest } from './api';
import { readingConnectionState, type ReadingConnectionState } from './api-error';
import { READING_SESSION_KEY, assertReadingSession, hasEarlierReadingChanges, pendingReading, readingSession,
  readReadingCache, readReadingDraft, writeValue, type PendingReading, type ReadingCache, type ReadingSession } from './storage';
import { isReadingSession } from './storage-validation';

/** Owns enrollment, session invalidation and hydration of this session's durable data. */
export function useReadingSession() {
  const [session, setSession] = useState<ReadingSession | null>(null);
  const [ready, setReady] = useState(false), [connecting, setConnecting] = useState(false);
  const [cache, setCache] = useState<ReadingCache | null>(null), [pending, setPending] = useState<PendingReading[]>([]);
  const [error, setError] = useState<string | null>(null), [storageError, setStorageError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ReadingConnectionState>('available');
  const [recovery, setRecovery] = useState(false);
  const [adding, setAdding] = useState(false), [url, setUrl] = useState(''), [share, setShare] = useState<string | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const alive = useRef(true), connectingRef = useRef(false), generation = useRef(0);
  const run = useCallback(async (action: () => Promise<void>) => {
    const revision = generation.current;
    try { await action(); } catch (cause) {
      if (alive.current && revision === generation.current) setError(cause instanceof Error ? cause.message : 'Reading is unavailable.');
    }
  }, []);
  const resetSession = useCallback(() => {
    generation.current++;
    setSession(null); setCache(null); setPending([]); setDraftReady(false); setStorageError(null);
    if (!share) { setUrl(''); setAdding(false); }
  }, [share]);
  const hydrate = useCallback(async (current: ReadingSession) => {
    const revision = generation.current;
    const currentRequest = () => {
      assertReadingSession(current);
      return alive.current && revision === generation.current;
    };
    if (!currentRequest()) return;
    setDraftReady(false); setStorageError(null);
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
  }, []);
  const connect = useCallback(async () => {
    if (connectingRef.current || !navigator.onLine || !localStorage.getItem(AUTH_TOKEN_KEY)) return;
    const revision = generation.current;
    connectingRef.current = true; setConnecting(true);
    try {
      const next = await connectReadingFromReminders();
      if (!alive.current || revision !== generation.current || !next) return;
      setError(null); setConnectionState('available');
      await hydrate(next);
    } catch (cause) {
      if (alive.current && revision === generation.current) {
        setConnectionState(readingConnectionState(cause));
        setError(cause instanceof Error ? cause.message : 'Reading is unavailable.');
      }
    } finally { connectingRef.current = false; if (alive.current) setConnecting(false); }
  }, [hydrate]);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    const lifetime = generation;
    const revision = lifetime.current;
    const pwaCurrent = capturePwaSession();
    let bootstrapCurrent = () => !cancelled && revision === lifetime.current;
    void run(async () => {
      try {
        const logout = localStorage.getItem(PWA_LOGOUT_KEY);
        let expectedSession = localStorage.getItem(READING_SESSION_KEY);
        bootstrapCurrent = () => {
          try {
            return !cancelled && revision === lifetime.current && pwaCurrent()
              && logout === localStorage.getItem(PWA_LOGOUT_KEY)
              && expectedSession === localStorage.getItem(READING_SESSION_KEY);
          } catch { return false; }
        };
        const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
        if (manifest) manifest.href = manifestHrefForUrl(location.href);
        const fragment = new URLSearchParams(location.hash.slice(1)), installed = isStandaloneApp();
        const installGrant = installed && !readingSession() ? document.cookie.split('; ').find(c => c.startsWith('crate-reading-install='))?.split('=')[1] : null;
        const grant = fragment.get('reading') || installGrant;
        if (grant) {
          history.replaceState(null, '', '/notifications?section=reading');
          const { installToken, ...next } = await readingRequest<ReadingSession & { installToken?: string }>('/reading/exchange', null, JSON.stringify({ token: grant }));
          if (!isReadingSession(next)) throw new Error('Reading sign-in could not be read. Reconnect from Obsidian settings.');
          if (!bootstrapCurrent()) {
            // Logout cannot revoke a credential whose exchange was still pending.
            // Discard and best-effort revoke only this unused response's token.
            void fetch('/auth/session', { method: 'DELETE', signal: AbortSignal.timeout(10_000),
              headers: { Authorization: `Bearer ${next.token}`, [CRATE_PROTOCOL_HEADER]: String(CRATE_PLUGIN_PROTOCOL.current) },
            }).catch(() => undefined);
            return;
          }
          const serialized = JSON.stringify(next);
          localStorage.setItem(READING_SESSION_KEY, serialized);
          expectedSession = serialized;
          document.cookie = 'crate-reading-install=; Max-Age=0; Path=/notifications; SameSite=Strict; Secure';
          if (!installed && installToken) document.cookie = `crate-reading-install=${installToken}; Max-Age=600; Path=/notifications; SameSite=Strict; Secure`;
        }
        const current = readingSession();
        if (current) await hydrate(current);
        else {
          const earlier = await hasEarlierReadingChanges();
          if (!bootstrapCurrent()) return;
          setRecovery(earlier);
        }
        if (!bootstrapCurrent()) return;
        const shareId = new URL(location.href).searchParams.get('share');
        if (shareId) {
          const draft = await readReadingDraft(`share:${shareId}`);
          if (!bootstrapCurrent()) return;
          if (draft) { setUrl(draft.url); setAdding(true); setShare(shareId); }
        }
        await registerPwaServiceWorker();
        if (!bootstrapCurrent()) return;
        navigator.serviceWorker?.controller?.postMessage({ type: 'CRATE_CLIENT_VERSION', version: PWA_ASSET_VERSION });
      } catch (cause) {
        if (bootstrapCurrent()) throw cause;
      } finally { if (!cancelled) setReady(true); }
    });
    return () => { cancelled = true; alive.current = false; lifetime.current++; };
  }, [run, hydrate]);
  useEffect(() => {
    if (!ready || session) return;
    const changed = (event: StorageEvent) => { if (event.key === AUTH_TOKEN_KEY || event.key === READING_SESSION_KEY || event.key === null) void connect(); };
    const retry = () => { void connect(); };
    const resume = () => { if (document.visibilityState === 'visible') retry(); };
    window.addEventListener('online', retry); window.addEventListener('pageshow', retry);
    window.addEventListener('storage', changed); window.addEventListener(PWA_AUTH_CHANGED_EVENT, retry);
    document.addEventListener('visibilitychange', resume);
    retry();
    return () => {
      window.removeEventListener('online', retry); window.removeEventListener('pageshow', retry);
      window.removeEventListener('storage', changed); window.removeEventListener(PWA_AUTH_CHANGED_EVENT, retry);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [ready, session, connect]);
  useEffect(() => {
    if (session && ready && draftReady) void run(() => writeValue(`draft:${session.id}`, { url }, session));
  }, [session, ready, draftReady, url, run]);
  return { session, ready, connecting, connect, resetSession, cache, setCache, pending, setPending, error: storageError ?? error,
    setError, recovery, connectionState, adding, setAdding, url, setUrl, share, setShare, alive, run };
}
