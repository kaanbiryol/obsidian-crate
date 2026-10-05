import { EncryptionTransitionError } from '../connection/encryption';
import { ConnectionError, connectionIssue, SESSION_RECOVERY_ISSUE, type ConnectionIssue } from '../connection/issues';
import { EncryptionKeyRequiredError } from '../encryption-onboarding';
import { resetReadingEncryption } from './encryption-lifecycle';
import { prepareReadingEncryption } from './encryption-session';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AUTH_TOKEN_KEY, PWA_AUTH_CHANGED_EVENT, PWA_LOGOUT_KEY, isStandaloneApp } from '../config';
import { capturePwaSession } from '../session-generation';
import { CRATE_PLUGIN_PROTOCOL, CRATE_PROTOCOL_HEADER } from '@/protocol';
import { connectReadingFromReminders, readingRequest } from './api';
import { readingConnectionState, type ReadingConnectionState } from './api-error';
import { READING_SESSION_KEY, assertReadingSession, readingSession, type ReadingSession } from './storage';
import { isReadingSession } from './storage-validation';

/** App-owned Reading connection; no article, draft or queue hydration. */
export function useReadingConnection(enabled: boolean, startupReady: boolean, authority?: object) {
  const [session, setSession] = useState<ReadingSession | null>(null);
  const [converting, setConverting] = useState(false);
  const [encryptionSetupRequired, setEncryptionSetupRequired] = useState(false);
  const [lockedSession, setLockedSession] = useState<ReadingSession | null>(null);
  const [ready, setReady] = useState(false), [connecting, setConnecting] = useState(false);
  const [issue, setIssue] = useState<ConnectionIssue | null>(null);
  const [connectionState, setConnectionState] = useState<ReadingConnectionState>('available');
  const alive = useRef(true), connectingRef = useRef(false), generation = useRef(0);
  const run = useCallback(async (action: () => Promise<void>) => {
    const revision = generation.current;
    try { await action(); } catch (cause) {
      if (alive.current && revision === generation.current) setIssue(connectionIssue(cause));
    }
  }, []);
  const resetSession = useCallback(() => {
    generation.current++; resetReadingEncryption();
    setSession(null); setLockedSession(null); setEncryptionSetupRequired(false); setConverting(false);
  }, []);
  const expire = useCallback(() => { resetSession(); setIssue(SESSION_RECOVERY_ISSUE); }, [resetSession]);
  const hydrate = useCallback(async (current: ReadingSession) => {
    const revision = generation.current;
    const currentRequest = () => {
      assertReadingSession(current);
      return alive.current && revision === generation.current;
    };
    if (!currentRequest()) return;
    try { await prepareReadingEncryption(current); } catch (cause) {
      if (!currentRequest()) return;
      setConverting(cause instanceof EncryptionTransitionError);
      setEncryptionSetupRequired(cause instanceof EncryptionKeyRequiredError && cause.firstUnlock);
      setLockedSession(current); setIssue(connectionIssue(cause)); return;
    }
    if (!currentRequest()) return;
    setLockedSession(null); setEncryptionSetupRequired(false); setConverting(false);
    setSession(current); setIssue(null);
    return true;
  }, []);
  const connect = useCallback(async () => {
    if (!startupReady || !enabled || connectingRef.current || !navigator.onLine || !localStorage.getItem(AUTH_TOKEN_KEY)) return;
    const revision = generation.current;
    connectingRef.current = true; setConnecting(true);
    try {
      const next = await connectReadingFromReminders();
      if (!alive.current || revision !== generation.current || !next) return;
      setIssue(null); setConnectionState('available');
      await hydrate(next);
    } catch (cause) {
      if (alive.current && revision === generation.current) {
        setConnectionState(readingConnectionState(cause));
        setIssue(connectionIssue(cause));
      }
    } finally { connectingRef.current = false; if (alive.current) setConnecting(false); }
  }, [startupReady, enabled, hydrate]);
  useEffect(() => {
    if (!startupReady) return;
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
        const fragment = new URLSearchParams(location.hash.slice(1)), installed = isStandaloneApp();
        const installGrant = installed && !readingSession() ? document.cookie.split('; ').find(c => c.startsWith('crate-reading-install='))?.split('=')[1] : null;
        const grant = fragment.get('reading') || installGrant;
        if (grant) {
          const shareId = new URL(location.href).searchParams.get('share');
          history.replaceState(null, '', '/notifications?section=reading' + (shareId ? '&share=' + encodeURIComponent(shareId) : ''));
          const { installToken, ...next } = await readingRequest<ReadingSession & { installToken?: string }>('/reading/exchange', null, JSON.stringify({ token: grant }));
          if (!isReadingSession(next)) throw new ConnectionError('reconnect', 'Reading sign-in could not be read. Reconnect from Obsidian settings.');
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
      } catch (cause) {
        if (bootstrapCurrent()) throw cause;
      } finally { if (!cancelled) setReady(true); }
    });
    return () => { cancelled = true; alive.current = false; lifetime.current++; };
  }, [startupReady, authority, run, hydrate]);
  useEffect(() => {
    if (!startupReady || !ready || session || lockedSession) return;
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
  }, [startupReady, ready, session, lockedSession, connect]);
  return { session, lockedSession, encryptionSetupRequired, converting, expire, ready, connecting, connect, resetSession, issue, error: issue?.message ?? null, connectionState };
}

export type ReadingConnection = ReturnType<typeof useReadingConnection>;
