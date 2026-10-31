import { readingUpdateReadiness } from '../update/update-readiness';
import { createContext, Fragment, useContext, useEffect, useRef, type ReactNode } from 'react';
import { SettingsRow } from '../settings/SettingsRow';
import { useSyncFailureToast } from '../hooks/useSyncFailureToast';
import { useSharedFeatures } from '../shared-features';
import { useSyncFeedback } from '../sync/SyncFeedback';
import { useFeatureSettings, useSettingsOpen } from '../settings/settings-context';
import { readingSyncStatus } from '../sync/reading-status';
import { useAppConnection, useConnectionReset } from '../connection/AppConnection';
import { earlierReadingChanges, exportReadingData, removeEarlierReadingChanges } from './storage/storage';
import { ReviewedReadingRemoval } from './ReviewedReadingRemoval';
import { assertReadingSession } from './session/session';
import { sameReadingSession } from './session/session';
import { useReadingSession } from './useReadingSession';
import { useReadingSync } from './useReadingSync';
import { useReadingMutations } from './useReadingMutations';
import { readingKeys } from './session/encryption-session';
import { readingNeedsAttention, readingRetryAt, removeReviewedReading } from './outbox';
import { ShortcutSetup } from './ShortcutSetup';

function useReadingController() {
	const enabled = useSharedFeatures().reading;
	const showToast = useSyncFeedback();
	const app = useAppConnection();
	const connection = useReadingSession(app.reading);
	const { session, lockedSession, ready, connecting, cache, pending, error, recovery, connectionState,
		adding, connect, resetSession } = connection;
	useConnectionReset(resetSession);
	const { refresh, refreshManually, syncing, syncedSession, isOffline } = useReadingSync(connection, enabled);
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
		isCurrent: () => { if (!session) return false; try { assertReadingSession(session); return true; } catch { return false; } },
	});
	const confirmed = Boolean(session && sameReadingSession(syncedSession, session));
	const status = readingSyncStatus({ pending, isOffline, loading: !cache, refreshing: syncing, confirmed, error, recovery });
	const readingDisabled = !session && connectionState !== 'available';
	useFeatureSettings('reading', {
		ready: ready && !connecting, connected: Boolean(session), enabled, pendingCount: pending.length,
		encryption: lockedSession ? { status: 'locked', folderPath: lockedSession.folderPath }
			: session ? { status: readingKeys() ? 'ready' : 'unencrypted', folderPath: readingKeys()?.folderPath ?? session.folderPath } : undefined,
		retryAt: Math.min(...pending.map(readingRetryAt).filter(deadline => deadline !== undefined)),
		status: enabled ? status : { state: recovery ? 'error' : 'cached', label: pending.length ? `Paused: ${pending.length} ${pending.length === 1 ? 'change' : 'changes'} saved on this device` : 'Paused' },
		...readingUpdateReadiness({ ready, connecting, enabled, connected: Boolean(session), hasCache: Boolean(cache),
			hasError: Boolean(error), adding, saving, preparingChange, syncing, isOffline,
			// A refresh in flight can clear its error; a paused feature sends nothing.
			stalled: recovery || pending.some(op => !enabled || readingNeedsAttention(op)) || Boolean(error && !readingDisabled && !syncing) }),
		canApplyUpdate,
		attention: status.state === 'error' && !readingDisabled ? error || status.label : null,
		unsynced: pending.length > 0 || recovery || Boolean(error && !readingDisabled),
		onRefresh: () => session ? refreshManually() : connect(),
		onExport: pending.length || recovery ? exportReadingData : undefined,
		clearView: resetSession,
		onLogout: app.logOut,
		shortcut: session ? <ShortcutSetup session={session} /> : null,
		issues: <>
			{recovery && <>
				<SettingsRow title="Earlier changes need review" description="Changes from an earlier sign-in are still stored on this device." />
				<ReviewedReadingRemoval fileName="crate-reading-earlier-changes.json" exportLabel="Export earlier changes"
					load={() => earlierReadingChanges(session?.id)}
					onRemove={async exported => {
						const removed = await removeEarlierReadingChanges(session?.id, exported);
						await connection.refreshRecovery();
						return removed;
					}} />
			</>}
			{pending.filter(op => op.error || op.review).map(op => <Fragment key={op.id}>
				<SettingsRow title={op.review ? 'Change needs review' : 'Couldn’t sync'} description={op.error || 'This change is still stored on this device.'} />
				{op.review && session && <ReviewedReadingRemoval fileName="crate-reading-change.json" exportLabel="Export change"
					load={async () => op}
					onRemove={async exported => {
						const next = await removeReviewedReading(session, op.id, exported);
						if (next) connection.publishPending(session, next);
						return next !== null;
					}} />}
			</Fragment>)}
		</>,
	});

	return { connection, sync: { refresh, refreshManually, syncing, syncedSession, isOffline }, showToast, claimFailure, saving, queueChange, saveLink, updateItem, retryArticle, deleteItem };
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
