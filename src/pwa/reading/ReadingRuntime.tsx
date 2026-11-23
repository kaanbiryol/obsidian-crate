import { readingUpdateReadiness } from '../update/update-readiness';
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useSyncFailureToast } from '../hooks/useSyncFailureToast';
import { useSharedFeatures } from '../shared-features';
import { useSyncFeedback } from '../sync/SyncFeedback';
import { useFeatureSettings, useSettingsOpen } from '../settings/settings-context';
import { readingFeatureStatus, readingSyncStatus } from '../sync/reading-status';
import { useAppConnection, useConnectionReset } from '../connection/AppConnection';
import { exportReadingData } from './storage/storage';
import { isReadingSessionCurrent } from './session/session';
import { sameReadingSession } from './session/session';
import { useReadingSession } from './useReadingSession';
import { useReadingSync } from './useReadingSync';
import { useReadingMutations } from './useReadingMutations';
import { readingEncryptionKeys, readingNoteFolder } from './session/encryption-session';
import { readingNeedsAttention } from './outbox';
import { ShortcutSetup } from './ShortcutSetup';
import { ReadingSettingsIssues } from './ReadingSettingsIssues';
import { readingConnectionView } from './connection-view';
import { useReadingLibrarySource } from './useReadingLibrarySource';
import { usePwaPreferences } from '../settings/usePwaPreferences';
import type { DockTab } from '../settings/dock-preferences';

const NO_DOCK_TABS: DockTab[] = [];

function useReadingController() {
	const enabled = useSharedFeatures().reading;
	const showToast = useSyncFeedback();
	const app = useAppConnection();
	const connection = useReadingSession(app.reading);
	const { session, lockedSession, ready, connecting, cache, pending, error, recovery, connectionState,
		adding, connect, resetSession, refreshRecovery, publishPending, readOnly, libraryFailed } = connection;
	useConnectionReset(resetSession);
	const { refresh, refreshManually, syncing, syncedSession, isOffline, retryAt } = useReadingSync(connection, enabled);
	// A refresh made offline read no library, so reconnecting loads one instead of listing an empty inbox.
	const library = cache?.offline ? null : cache;
	const { savedOnly } = readingConnectionView({ isOffline, readOnly, hasSession: !!session, hasCache: !!library, libraryFailed, error, connectionState });
	const { dockTabs } = usePwaPreferences().preferences;
	// A paused Reading feature prefetches nothing.
	const librarySource = useReadingLibrarySource({ session, savedOnly, library, pending, dockTabs: enabled ? dockTabs : NO_DOCK_TABS });
	const { saving, preparingChange, canApplyUpdate, queueChange, saveLink, updateItem, retryArticle, deleteItem } = useReadingMutations(connection, { refresh, showToast });
	const [, setSettingsOpen] = useSettingsOpen();
	const previousSession = useRef(session);
	useEffect(() => {
		if (previousSession.current && !session) setSettingsOpen(false);
		previousSession.current = session;
	}, [session, setSettingsOpen]);
	const claimFailure = useSyncFailureToast({
		scope: session ? JSON.stringify([session.id, session.token, session.generation]) : null,
		ready,
		operationIds: pending.filter(op => op.sessionId === session?.id && readingNeedsAttention(op)).map(op => op.id),
		feature: 'Reading', showToast,
		isCurrent: () => Boolean(session && isReadingSessionCurrent(session)),
	});
	const confirmed = Boolean(session && sameReadingSession(syncedSession, session));
	const syncStatus = readingSyncStatus({ pending, isOffline, loading: !cache, refreshing: syncing, confirmed, error, recovery });
	const readingDisabled = !session && connectionState !== 'available';
	// Rebuilt only when their inputs change, so an unchanged model publishes nothing.
	const shortcut = useMemo(() => session ? <ShortcutSetup session={session} /> : null, [session]);
	const issues = useMemo(() => <ReadingSettingsIssues connection={{ session, pending, recovery, refreshRecovery, publishPending }} />,
		[session, pending, recovery, refreshRecovery, publishPending]);
	useFeatureSettings('reading', {
		ready: ready && !connecting, connected: Boolean(session), enabled, pendingCount: pending.length,
		encryption: lockedSession ? { status: 'locked', folderPath: lockedSession.folderPath }
			: session ? { status: readingEncryptionKeys() ? 'ready' : 'unencrypted', folderPath: readingNoteFolder(session) } : undefined,
		retryAt,
		...readingUpdateReadiness({ ready, connecting, enabled, connected: Boolean(session), hasCache: Boolean(cache),
			hasError: Boolean(error), adding, saving, preparingChange, syncing, isOffline,
			// A refresh in flight can clear its error; a paused feature sends nothing.
			stalled: recovery || pending.some(op => !enabled || readingNeedsAttention(op)) || Boolean(error && !readingDisabled && !syncing) }),
		canApplyUpdate,
		...readingFeatureStatus({ enabled, syncStatus, pendingCount: pending.length, recovery, error, disabled: readingDisabled }),
		onRefresh: () => session ? refreshManually() : connect(),
		onExport: pending.length || recovery ? exportReadingData : undefined,
		clearView: resetSession,
		onLogout: app.logOut,
		shortcut,
		issues,
	});

	return { connection, librarySource, sync: { refresh, refreshManually, syncing, syncedSession, isOffline }, showToast, claimFailure, saving, queueChange, saveLink, updateItem, retryArticle, deleteItem };
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
