import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { PWA_ASSET_VERSION } from '@/cloudflare/worker/pwa-version';
import { makeApiFetch, registerPwaServiceWorker } from '../api';
import { onConnectionExpired } from './expiration';
import type { ConnectionIssue } from './issues';
import { READING_SESSION_KEY, readingSession } from '../reading/storage';
import { AUTH_TOKEN_KEY, loadStoredConfig } from '../config';
import { encryptionSnapshot, subscribeEncryption } from '../encryption-session';
import { usePwaBootstrap } from '../hooks/usePwaBootstrap';
import { usePwaSessionLifecycle } from '../hooks/usePwaSessionLifecycle';
import { usePwaPreferences } from '../hooks/usePwaPreferences';
import { useReadingConnection } from '../reading/useReadingConnection';
import { useSettingsOpen } from '../settings-context';
import { useSharedFeatures } from '../shared-features';
import { useSyncFeedback } from '../sync/SyncFeedback';
import type { StartTab } from '../types';

/** Owns authentication, enrollment, encryption readiness and logout for one Crate app. */
function useConnection() {
  const [authority, setAuthority] = useState(() => ({ token: localStorage.getItem(AUTH_TOKEN_KEY) }));
  const setAuthToken = useCallback<Dispatch<SetStateAction<string | null>>>(next => {
    setAuthority(current => ({ token: typeof next === 'function' ? next(current.token) : next }));
  }, []);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [config, setConfig] = useState(loadStoredConfig);
  const [error, reportError] = useState<ConnectionIssue | null>(null);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const { preferences } = usePwaPreferences();
  const [startTab, setStartTab] = useState<StartTab>(() => ['today', 'inbox', 'upcoming', 'browse'].includes(preferences.defaultScreen) ? preferences.defaultScreen as StartTab : 'today');
  const [launchReminderId, setLaunchReminderId] = useState<string | null>(null);
  const [, setSettingsOpen] = useSettingsOpen();
  const showToast = useSyncFeedback();
  const resets = useRef(new Set<() => void>());
  const registerReset = useCallback((reset: () => void) => { resets.current.add(reset); return () => { resets.current.delete(reset); }; }, []);
  const resetView = useCallback(() => { for (const reset of resets.current) reset(); }, []);
  const pushCleanup = useRef<() => Promise<void>>(async () => {});
  const registerPushCleanup = useCallback((cleanup: () => Promise<void>) => {
    pushCleanup.current = cleanup;
    return () => { if (pushCleanup.current === cleanup) pushCleanup.current = async () => {}; };
  }, []);
  const disablePushNotifications = useCallback(() => pushCleanup.current(), []);
  const handleUnauthorizedRef = useRef<() => void>(() => undefined);
  const apiFetch = useMemo(() => makeApiFetch(authority.token, () => handleUnauthorizedRef.current()), [authority]);
  const lifecycle = usePwaSessionLifecycle({ apiFetch, resetView, disablePushNotifications, handleUnauthorizedRef,
    setAuthToken, setConfig, reportError, setSettingsOpen, showToast });
  usePwaBootstrap({ authToken: authority.token, suspendLocalSession: lifecycle.suspendLocalSession,
    setAuthToken, setBootstrapped, setConfig, reportError, setLaunchReminderId, setSelectedProject, setStartTab, showToast });
  const encryption = useSyncExternalStore(subscribeEncryption, encryptionSnapshot);
  // Finish app enrollment before Reading uses its credential or a direct setup link.
  const reading = useReadingConnection(useSharedFeatures().reading, bootstrapped, authority);

  const expireReading = reading.expire;
  useEffect(() => onConnectionExpired(token => {
    if (localStorage.getItem(AUTH_TOKEN_KEY) === token) handleUnauthorizedRef.current();
    else if (readingSession()?.token === token) { localStorage.removeItem(READING_SESSION_KEY); expireReading(); }
  }), [expireReading]);

  useEffect(() => {
    if (!bootstrapped) return;
    const reportVersion = () => navigator.serviceWorker?.controller?.postMessage({ type: 'CRATE_CLIENT_VERSION', version: PWA_ASSET_VERSION });
    navigator.serviceWorker?.addEventListener('controllerchange', reportVersion);
    document.addEventListener('visibilitychange', reportVersion);
    void registerPwaServiceWorker().then(reportVersion).catch((cause: unknown) => {
      showToast('error', `Offline support could not start: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
    return () => {
      navigator.serviceWorker?.removeEventListener('controllerchange', reportVersion);
      document.removeEventListener('visibilitychange', reportVersion);
    };
  }, [bootstrapped, showToast]);

  return { authority, authToken: authority.token, apiFetch, bootstrapped, config, error, encryption, reading,
    selectedProject, setSelectedProject, startTab, launchReminderId, setLaunchReminderId,
    registerReset, registerPushCleanup, ...lifecycle };
}

const ConnectionContext = createContext<ReturnType<typeof useConnection> | null>(null);
export function AppConnectionProvider({ children }: { children: ReactNode }) {
  const connection = useConnection();
  return <ConnectionContext.Provider value={connection}>{children}</ConnectionContext.Provider>;
}
export function useAppConnection() {
  const connection = useContext(ConnectionContext);
  if (!connection) throw new Error('Crate connection must be mounted above its features');
  return connection;
}
export function useConnectionReset(reset: () => void) {
  const { registerReset } = useAppConnection();
  useLayoutEffect(() => registerReset(reset), [registerReset, reset]);
}
