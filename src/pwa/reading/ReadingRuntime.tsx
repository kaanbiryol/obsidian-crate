import { readingUpdateReadiness } from '../sync/update-readiness';
import { createContext, lazy, useContext, useEffect, useRef, type ReactNode } from 'react';
import { DeferredNotice } from '../components/DeferredNotice';
import { SettingsRow } from '../components/SettingsRow';
import { useSyncFailureToast } from '../hooks/useSyncFailureToast';
import { useSharedFeatures } from '../shared-features';
import { useSyncFeedback } from '../sync/SyncFeedback';
import { useFeatureSettings, useSettingsOpen } from '../settings-context';
import { readingSyncStatus } from '../sync/reading-status';
import { useAppConnection, useConnectionReset } from '../connection/AppConnection';
import { assertReadingSession, exportReadingData } from './storage';
import { useReadingSession } from './useReadingSession';
import { useReadingSync } from './useReadingSync';
import { useReadingMutations } from './useReadingMutations';
import { readingKeys } from './encryption-session';
import { readingNeedsAttention, readingRetryAt } from './outbox';


const ShortcutSetup = lazy(() => import('./ShortcutSetup').then(module => ({ default: module.ShortcutSetup })));

function useReadingController() {
  const enabled = useSharedFeatures().reading;
  const showToast = useSyncFeedback();
  const app = useAppConnection();
  const connection = useReadingSession(app.reading);
  const { session, lockedSession, ready, connecting, cache, pending, error, recovery, connectionState,
    adding, connect, resetSession } = connection;
  useConnectionReset(resetSession);
  const { refresh, refreshManually, syncing, syncedSession, isOffline } = useReadingSync(connection, enabled);
  const { saving, preparingChange, canApplyUpdate, queueChange, saveLink, updateItem, retryArticle } = useReadingMutations(connection, { refresh, showToast });
  const [, setSettingsOpen] = useSettingsOpen();
  const previousSession = useRef(session);
  useEffect(() => {
    if (previousSession.current && !session) setSettingsOpen(false);
    previousSession.current = session;
  }, [session, setSettingsOpen]);
  useSyncFailureToast({
    scope: session ? JSON.stringify([session.id, session.token, session.generation]) : null,
    ready,
    operationIds: pending.filter(op => op.sessionId === session?.id && readingNeedsAttention(op)).map(op => op.id),
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
    retryAt: Math.min(...pending.map(readingRetryAt).filter(deadline => deadline !== undefined)),
    status: enabled ? status : { state: recovery ? 'error' : 'cached', label: pending.length ? `Paused: ${pending.length} ${pending.length === 1 ? 'change' : 'changes'} saved on this device` : 'Paused' },
    ...readingUpdateReadiness({ ready, connecting, enabled, connected: Boolean(session), hasCache: Boolean(cache),
      hasError: Boolean(error), adding, saving, preparingChange, syncing, isOffline }),
    canApplyUpdate,
    attention: status.state === 'error' && !readingDisabled ? error || status.label : null,
    unsynced: pending.length > 0 || recovery || Boolean(error && !readingDisabled),
    onRefresh: () => session ? refreshManually() : connect(),
    onExport: pending.length || recovery ? exportReadingData : undefined,
    clearView: resetSession,
    onLogout: app.logOut,
    shortcut: session ? <DeferredNotice><ShortcutSetup session={session} /></DeferredNotice> : null,
    issues: <>
      {recovery && <SettingsRow title="Earlier changes need review" description="Changes from an earlier sign-in are still stored on this device." />}
      {pending.filter(op => op.error || op.review).map(op => <SettingsRow key={op.id} title={op.review ? 'Change needs review' : 'Couldn’t sync'} description={op.error || 'This change is still stored on this device.'} />)}
    </>,
  });

  return { connection, sync: { refresh, refreshManually, syncing, syncedSession, isOffline }, showToast, saving, queueChange, saveLink, updateItem, retryArticle };
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
