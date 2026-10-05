import { createContext, lazy, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isStandaloneApp } from '../config';
import { useAppConnection, useConnectionReset } from '../connection/AppConnection';
import { capturePwaSession } from '../session-generation';
import { loadCachedReminderSnapshot } from '../reminder-cache';
import { EncryptionKeyRequiredError } from '../encryption-onboarding';
import { exportPendingChanges } from '../export-pending-changes';
import { usePushNotifications } from '../hooks/usePushNotifications';
import { usePwaColorScheme } from '../hooks/usePwaColorScheme';
import { usePwaPreferences } from '../hooks/usePwaPreferences';
import { usePwaRefreshLifecycle } from '../hooks/usePwaRefreshLifecycle';
import { usePwaStatus } from '../hooks/usePwaStatus';
import { useReminderEditor } from '../hooks/useReminderEditor';
import { useReminderMutations } from '../hooks/useReminderMutations';
import { useReminderSync } from '../hooks/useReminderSync';
import { useSyncFeedback } from '../sync/SyncFeedback';
import { isInitialPwaContentReady } from '../initial-content-readiness';
import { useSharedFeatures } from '../shared-features';
import { toSharedReminder } from '../reminder-list-state';
import { useFeatureSettings, useSettingsOpen } from '../settings-context';
import type {
	ModalMode,
} from '../types';
import { DeferredNotice } from './DeferredNotice';
import { reminderSyncStatus } from '../sync/reminder-status';
import { reminderRetryAt } from '../reminder-outbox';

const ReminderRecoveryNotice = lazy(() => import('./ReminderRecoveryNotice')
	.then(module => ({ default: module.ReminderRecoveryNotice })));
const ReminderQuarantineNotice = lazy(() => import('./ReminderQuarantineNotice')
	.then(module => ({ default: module.ReminderQuarantineNotice })));


function useRemindersController() {
	const enabled = useSharedFeatures().reminders;
	const connection = useAppConnection();
	const { authority, authToken, apiFetch, config: storedConfig, encryption, logOut, loggingOut,
		selectedProject, setSelectedProject, startTab, launchReminderId, setLaunchReminderId, registerPushCleanup } = connection;
	const [hydratedAuthority, setHydratedAuthority] = useState<object | null>(null);
	const bootstrapped = connection.bootstrapped && hydratedAuthority === authority;
	const { colorScheme } = usePwaColorScheme();
	const isDarkMode = colorScheme === 'dark';
	const { preferences } = usePwaPreferences();
	const config = useMemo(() => ({ ...storedConfig, upcomingDays: preferences.upcomingDays ?? storedConfig.upcomingDays }), [storedConfig, preferences.upcomingDays]);
	const [settingsOpen, setSettingsOpen] = useSettingsOpen();
	const { modal, saving, setSaving, transition: modalTransition, closeModal, resetEditor, openEditor, openReminder } = useReminderEditor(setSettingsOpen);
	const [reorderDragging, setReorderDragging] = useState(false);
	const showToast = useSyncFeedback();
	const reminderSync = useReminderSync({ apiFetch, authToken, config, setSelectedProject, enabled });
	const resolvePageTitle = useCallback(async (url: string) => {
		const response = await apiFetch('/links/title', { method: 'POST', body: JSON.stringify({ url }), signal: AbortSignal.timeout(7000) });
		if (!response.ok) return null;
		const result = await response.json() as { title?: unknown };
		return typeof result.title === 'string' ? result.title : null;
	}, [apiFetch]);
	const {
		push,
		initialCheckComplete,
		refreshPushState,
		enablePushNotifications,
		disablePushNotifications,
	} = usePushNotifications({ authToken, apiFetch, prepareSession: apiFetch.ready, showToast });
	const {
		reminders,
		projects,
		loading,
		refreshing,
		error,
		issues,
		dataMode,
		lastUpdatedAt,
		isOffline,
		getSnapshot,
		hasHydratedCache,
		hydrateCachedSnapshot,
		loadReminders,
		rebuildOfflineCache,
		beginLocalMutation,
		commitReminderState,
		resetReminderState,
		refreshPresentation,
		reportError,
	} = reminderSync;
	const resetView = useCallback(() => { resetEditor(); resetReminderState(); }, [resetEditor, resetReminderState]);
	useConnectionReset(resetView);
	useEffect(() => registerPushCleanup(disablePushNotifications), [registerPushCleanup, disablePushNotifications]);
	useEffect(() => {
		if (!connection.bootstrapped) return;
		let cancelled = false;
		const current = capturePwaSession();
		void (async () => {
			try {
				if (!authToken) { resetView(); return; }
				await apiFetch.ready();
				const cached = await loadCachedReminderSnapshot(config.folderPath);
				if (!cancelled && current() && cached) hydrateCachedSnapshot(cached);
			} catch (cause) {
				if (!cancelled && current() && !(cause instanceof EncryptionKeyRequiredError)) reportError(cause instanceof Error ? cause.message : String(cause));
			} finally { if (!cancelled) setHydratedAuthority(authority); }
		})();
		return () => { cancelled = true; };
	}, [connection.bootstrapped, authority, authToken, apiFetch, config.folderPath, hydrateCachedSnapshot, reportError, resetView]);

	usePwaRefreshLifecycle({
		enabled,
		authToken,
		bootstrapped,
		hasHydratedCache,
		loadReminders,
		refreshPushState,
	});

	const {
		readOnlyMessage,
		readOnly,
		canShowNotificationPrompt,
		statusText,
		statusKind,
	} = usePwaStatus({
		authToken,
		bootstrapped,
		dataMode,
		error,
		isOffline,
		lastUpdatedAt,
		push,
		refreshing,
	});

	const ensureCanMutate = useCallback(() => {
		if (!enabled) return false;
		if (!readOnlyMessage) return true;
		showToast('info', readOnlyMessage);
		return false;
	}, [enabled, readOnlyMessage, showToast]);

	const handlePullRefresh = useCallback(() => loadReminders({ silent: true }), [loadReminders]);


	const toggleSettings = useCallback(() => setSettingsOpen(open => !open), [setSettingsOpen]);

	const {
		saveReminder,
		toggleReminderCompleted,
		deleteReminder,
		persistReorder,
		visibleReminders,
		visibleProjects,
		changes,
		ready: mutationsReady,
		retryChange,
		discardChange,
		prepareEdit,
		isPreparingMutation,
		storageError,
		retryInitialization,
		recoveryChanges,
		recoverChanges,
		quarantinedChanges,
		removeQuarantinedChanges,
	} = useReminderMutations({
		enabled,
		hasSnapshot: lastUpdatedAt !== null,
		canRecover: enabled && !readOnly,
		apiFetch,
		authToken,
		bootstrapped,
		reminders,
		loadReminders,
		beginLocalMutation,
		commitReminderState,
		closeModal,
		config,
		ensureCanMutate,
		projects,
		getSnapshot,
		selectedProject,
		refreshPresentation,
		setSaving,
		showToast,
	});

	const initialContentReady = isInitialPwaContentReady({
		notificationPromptReady: !isStandaloneApp() || initialCheckComplete,
		authToken,
		bootstrapped,
		loading,
		pendingChangesReady: mutationsReady || Boolean(storageError),
	});

	const openModal = useCallback((mode: ModalMode, reminderId?: string, defaultProject?: string) => {
		if (!mutationsReady || !ensureCanMutate()) return;
		if (reminderId && changes.some(change => (change.status !== 'failed' || change.reviewRequired)
			&& (change.recordId === reminderId || change.optimistic?.id === reminderId))) {
			showToast('info', 'This reminder is still syncing. Retry its pending change first.');
			return;
		}
		const reminder = reminderId ? visibleReminders.find((item) => item.id === reminderId) ?? null : null;
		openReminder(mode, reminder, defaultProject ?? selectedProject);
	}, [changes, ensureCanMutate, mutationsReady, visibleReminders, selectedProject, openReminder, showToast]);

	const editFailedChange = useCallback((operationId: string) => {
		if (!mutationsReady || !ensureCanMutate()) return;
		const draft = prepareEdit(operationId);
		if (draft) openEditor(draft);
	}, [ensureCanMutate, mutationsReady, prepareEdit, openEditor]);


	const sharedReminders = useMemo(() => visibleReminders.map(toSharedReminder), [visibleReminders]);
	const editReminder = useCallback((id: string) => {
		const failedSave = changes.find(change => change.kind === 'save' && change.status === 'failed'
			&& (change.recordId === id || change.optimistic?.id === id));
		if (failedSave) editFailedChange(failedSave.operationId);
		else openModal('edit', id);
	}, [changes, editFailedChange, openModal]);
	const syncStatus = reminderSyncStatus({ changes, isOffline, refreshing, loading, dataMode, error, storageError });
	const needsRecovery = recoveryChanges.length > 0 || quarantinedChanges.length > 0;
	useFeatureSettings('reminders', {
		ready: bootstrapped && (mutationsReady || Boolean(storageError) || !authToken),
		enabled, pendingCount: changes.length,
		retryAt: Math.min(...changes.flatMap(change => reminderRetryAt(change) ?? [])),
		connected: Boolean(authToken), config, push,
		updateContentReady: !enabled || initialContentReady,
		updateReady: bootstrapped && !modal && !saving && !loggingOut && !reorderDragging && !isPreparingMutation()
			&& (!authToken || (mutationsReady && (!enabled || (initialContentReady && !launchReminderId && !loading && !refreshing && !isOffline))
				&& !storageError && changes.length === 0 && recoveryChanges.length === 0 && quarantinedChanges.length === 0)),
		status: enabled ? syncStatus : { state: needsRecovery || storageError ? 'error' : 'cached', label: changes.length ? `Paused: ${changes.length} ${changes.length === 1 ? 'change' : 'changes'} saved on this device` : 'Paused' },
		attention: needsRecovery ? 'Saved reminder changes need review.' : syncStatus.state === 'error' ? syncStatus.label : null,
		unsynced: changes.length > 0 || needsRecovery || Boolean(storageError),
		onRefresh: handlePullRefresh,
		onExport: changes.length || recoveryChanges.length ? () => exportPendingChanges([...changes, ...recoveryChanges]) : undefined,
		onEnablePush: enablePushNotifications,
		onLogout: logOut,
		clearView: resetView,
		recovery: <>
			{recoveryChanges.length > 0 && <DeferredNotice><ReminderRecoveryNotice changes={recoveryChanges} folderPath={config.folderPath} onResume={enabled ? recoverChanges : undefined} /></DeferredNotice>}
			{quarantinedChanges.length > 0 && <DeferredNotice><ReminderQuarantineNotice entries={quarantinedChanges} folderPath={config.folderPath} onRemove={removeQuarantinedChanges} /></DeferredNotice>}
		</>,
	});

	return {
		encryption, logOut, loggingOut, colorScheme, isDarkMode, authToken, bootstrapped, config, selectedProject,
		setSelectedProject, startTab, settingsOpen, launchReminderId, setLaunchReminderId, modal,
		saving, modalTransition, closeModal, openReminder, reorderDragging, setReorderDragging,
		showToast, loading, refreshing, error,
		issues, dataMode, isOffline, loadReminders, rebuildOfflineCache, enablePushNotifications,
		readOnlyMessage, readOnly, canShowNotificationPrompt, statusText, statusKind, handlePullRefresh,
		toggleSettings, saveReminder, toggleReminderCompleted, deleteReminder, persistReorder, visibleReminders,
		visibleProjects, changes, mutationsReady, retryChange, discardChange, storageError,
		retryInitialization, recoveryChanges, recoverChanges, quarantinedChanges, removeQuarantinedChanges, initialContentReady,
		openModal, editFailedChange, sharedReminders, editReminder, resolvePageTitle,
	};
}

const RemindersRuntimeContext = createContext<ReturnType<typeof useRemindersController> | null>(null);
export function RemindersRuntimeProvider({ children }: { children: ReactNode }) {
	const runtime = useRemindersController();
	return <RemindersRuntimeContext.Provider value={runtime}>{children}</RemindersRuntimeContext.Provider>;
}
export function useRemindersRuntime() {
	const runtime = useContext(RemindersRuntimeContext);
	if (!runtime) throw new Error("Reminders sync must be mounted inside the PWA coordinator");
	return runtime;
}
