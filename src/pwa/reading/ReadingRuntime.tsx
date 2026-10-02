import { createContext, lazy, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { DeferredNotice } from '../components/DeferredNotice';
import { SettingsRow } from '../components/SettingsRow';
import { useSyncFailureToast } from '../hooks/useSyncFailureToast';
import { useSharedFeatures } from '../shared-features';
import { useSyncFeedback } from '../sync/SyncFeedback';
import { useFeatureSettings, useSettingsOpen } from '../settings-context';
import { readingSyncStatus } from '../sync/reading-status';
import { logoutReadingApp } from './logout';
import { assertReadingSession, exportReadingData } from './storage';
import { useReadingSession } from './useReadingSession';
import { useReadingSync } from './useReadingSync';
import { readingKeys } from './encryption-session';


const ShortcutSetup = lazy(() => import('./ShortcutSetup').then(module => ({ default: module.ShortcutSetup })));

function useReadingController() {
  const enabled = useSharedFeatures().reading;
  const showToast = useSyncFeedback();
  const connection = useReadingSession(enabled);
  const { session, lockedSession, ready, connecting, cache, pending, error, setError, recovery, connectionState,
    adding, connect, resetSession } = connection;
  const { refresh, refreshManually, syncing, syncedSession, isOffline } = useReadingSync(connection, enabled);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [, setSettingsOpen] = useSettingsOpen();
  const previousSession = useRef(session);
  useEffect(() => {
    if (previousSession.current && !session) setSettingsOpen(false);
    previousSession.current = session;
  }, [session, setSettingsOpen]);
  useSyncFailureToast({
    scope: session ? JSON.stringify([session.id, session.token, session.generation]) : null,
    ready,
    operationIds: pending.filter(op => op.sessionId === session?.id && (op.review || op.error && (op.retryAt === undefined || (op.attempts ?? 0) >= 3))).map(op => op.id),
    feature: 'Reading', showToast,
    isCurrent: () => { if (!session) return false; try { assertReadingSession(session); return true; } catch { return false; } },
  });
  const confirmed = Boolean(session && syncedSession?.id === session.id && syncedSession.token === session.token && syncedSession.generation === session.generation);
  const status = readingSyncStatus({ pending, isOffline, loading: !cache, refreshing: syncing, confirmed, error, recovery });
  const readingDisabled = !session && connectionState !== 'available';
  useFeatureSettings('reading', {
    ready: ready && !connecting, connected: Boolean(session), enabled, pendingCount: pending.length,
    encryption: lockedSession ? { status: 'locked', folderPath: lockedSession.folderPath }
      : session ? { status: readingKeys() ? 'ready' : 'legacy', folderPath: readingKeys()?.folderPath ?? session.folderPath } : undefined,
    retryAt: Math.min(...pending.flatMap(op => op.retryAt !== undefined && !op.review && (op.attempts ?? 0) < 3 ? [op.retryAt] : [])),
    status: enabled ? status : { state: recovery ? 'error' : 'cached', label: pending.length ? `Paused: ${pending.length} ${pending.length === 1 ? 'change' : 'changes'} saved on this device` : 'Paused' },
    updateContentReady: ready && !connecting && (!enabled || !session || Boolean(cache) || Boolean(error)),
    updateReady: ready && !connecting && !adding && !saving && !syncing && !isOffline,
    attention: status.state === 'error' && !readingDisabled ? error || status.label : null,
    unsynced: pending.length > 0 || recovery || Boolean(error && !readingDisabled),
    onRefresh: () => session ? refreshManually() : connect(),
    onExport: pending.length || recovery ? exportReadingData : undefined,
    clearView: resetSession,
    onLogout: async () => {
      setSettingsOpen(false); resetSession();
      const error = await logoutReadingApp();
      setError(error);
      if (error) showToast('error', error);
    },
    shortcut: session ? <DeferredNotice><ShortcutSetup session={session} /></DeferredNotice> : null,
    issues: <>
      {recovery && <SettingsRow title="Earlier changes need review" description="Changes from an earlier sign-in are still stored on this device." />}
      {pending.filter(op => op.error || op.review).map(op => <SettingsRow key={op.id} title={op.review ? 'Change needs review' : 'Couldn’t sync'} description={op.error || 'This change is still stored on this device.'} />)}
    </>,
  });

  return { connection, sync: { refresh, refreshManually, syncing, syncedSession, isOffline }, showToast, saving, setSaving, savingRef };
}
const ReadingRuntimeContext = createContext<ReturnType<typeof useReadingController> | null>(null);
export function ReadingRuntimeProvider({ children }: { children: ReactNode }) {
  const runtime = useReadingController();
  return <ReadingRuntimeContext.Provider value={runtime}>{children}</ReadingRuntimeContext.Provider>;
}
export function useReadingRuntime() {
  const runtime = useContext(ReadingRuntimeContext);
  if (!runtime) throw new Error('Reading sync must be mounted inside the PWA coordinator');
  return runtime;
}
