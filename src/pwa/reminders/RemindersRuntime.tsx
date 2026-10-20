import { reminderUpdateReadiness } from '../sync/update-readiness';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isStandaloneApp } from '../config';
import { useAppConnection, useConnectionReset } from '../connection/AppConnection';
import { capturePwaSession } from '../session-generation';
import { loadCachedReminderSnapshot } from './cache/reminder-cache';
import { EncryptionKeyRequiredError } from '../encryption/encryption-onboarding';
import { exportPendingChanges } from './outbox/export-pending-changes';
import { usePushNotifications } from './usePushNotifications';
import { usePwaColorScheme } from '../hooks/usePwaColorScheme';
import { usePwaPreferences } from '../hooks/usePwaPreferences';
import { usePwaRefreshLifecycle } from './usePwaRefreshLifecycle';
import { usePwaStatus } from './usePwaStatus';
import { useReminderEditorActions } from './editor/useReminderEditorActions';
import { useReminderEditor } from './editor/useReminderEditor';
import { useReminderMutations } from './useReminderMutations';
import { useReminderSync } from './useReminderSync';
import { useSyncFeedback } from '../sync/SyncFeedback';
import { isInitialPwaContentReady } from '../initial-content-readiness';
import { useSharedFeatures } from '../shared-features';
import { toSharedReminder } from './outbox/reminder-list-state';
import { useFeatureSettings, useSettingsOpen } from '../settings-context';
import { ReminderRecoveryNotices } from './notices/ReminderRecoveryNotices';
import { reminderFeatureStatus, reminderSyncStatus } from '../sync/reminder-status';
import { reminderRetryAt } from './outbox/reminder-outbox';



function useRemindersController() {
	const enabled = useSharedFeatures().reminders;
	const connection = useAppConnection();
	const { authority, authToken, apiFetch, config: storedConfig, logOut, loggingOut,
		selectedProject, setSelectedProject, startTab, launchReminderId, setLaunchReminderId, registerPushCleanup } = connection;
	const [hydratedAuthority, setHydratedAuthority] = useState<object | null>(null);
	const bootstrapped = connection.bootstrapped && hydratedAuthority === authority;
	const { colorScheme } = usePwaColorScheme();
	const isDarkMode = colorScheme === 'dark';
	const { preferences } = usePwaPreferences();
	const config = useMemo(() => ({ ...storedConfig, upcomingDays: preferences.upcomingDays ?? storedConfig.upcomingDays }), [storedConfig, preferences.upcomingDays]);
	const [settingsOpen, setSettingsOpen] = useSettingsOpen();
	const editor = useReminderEditor(setSettingsOpen);
	const { modal, saving, resetEditor } = editor;
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
		indexingProgress,
		error,
		dataMode,
		lastUpdatedAt,
		isOffline,
		getSnapshot,
		hasHydratedCache,
		hydrateCachedSnapshot,
		loadReminders,
		beginLocalMutation,
		invalidateReads,
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

	const status = usePwaStatus({
		authToken,
		bootstrapped,
		dataMode,
		error,
		isOffline,
		lastUpdatedAt,
		push,
		refreshing,
	});

	const { readOnlyMessage, readOnly } = status;

	const ensureCanMutate = useCallback(() => {
		if (!enabled) return false;
		if (!readOnlyMessage) return true;
		showToast('info', readOnlyMessage);
		return false;
	}, [enabled, readOnlyMessage, showToast]);

	const handlePullRefresh = useCallback(() => loadReminders({ silent: true }), [loadReminders]);


	const toggleSettings = useCallback(() => setSettingsOpen(open => !open), [setSettingsOpen]);

	const mutations = useReminderMutations({
		enabled,
		hasSnapshot: lastUpdatedAt !== null,
		canRecover: enabled && !readOnly,
		apiFetch,
		authToken,
		bootstrapped,
		reminders,
		loadReminders,
		beginLocalMutation,
		invalidateReads,
		commitReminderState,
		config,
		ensureCanMutate,
		projects,
		getSnapshot,
		selectedProject,
		refreshPresentation,
		showToast,
	});

	const {
		visibleReminders,
		changes,
		ready: mutationsReady,
		isPreparingMutation,
		storageError,
		recoveryChanges,
		recoverChanges,
		quarantinedChanges,
		removeQuarantinedChanges,
	} = mutations;

	const initialContentReady = isInitialPwaContentReady({
		notificationPromptReady: !isStandaloneApp() || initialCheckComplete,
		authToken,
		bootstrapped,
		loading,
		pendingChangesReady: mutationsReady || Boolean(storageError),
	});

	const editorActions = useReminderEditorActions({
		editor, mutations, selectedProject, folderPath: config.folderPath, ensureCanMutate, showToast,
	});
	const sharedReminders = useMemo(() => visibleReminders.map(toSharedReminder), [visibleReminders]);

	const syncStatus = reminderSyncStatus({ changes, isOffline, refreshing, loading, indexingProgress, dataMode, error, storageError });
	const needsRecovery = recoveryChanges.length > 0 || quarantinedChanges.length > 0;
	useFeatureSettings('reminders', {
		ready: bootstrapped && (mutationsReady || Boolean(storageError) || !authToken),
		enabled, pendingCount: changes.length,
		retryAt: Math.min(...changes.flatMap(change => reminderRetryAt(change) ?? [])),
		connected: Boolean(authToken), config, push,
		...reminderUpdateReadiness({
			bootstrapped, enabled, connected: Boolean(authToken), mutationsReady, initialContentReady,
			interacting: Boolean(modal) || saving || loggingOut || reorderDragging,
			preparingMutation: isPreparingMutation(), launchPending: Boolean(launchReminderId),
			loading, refreshing, isOffline, unsettled: Boolean(storageError) || changes.length > 0 || needsRecovery,
		}),
		canApplyUpdate: () => !isPreparingMutation(),
		...reminderFeatureStatus({ enabled, syncStatus, pendingCount: changes.length, needsRecovery, storageError }),
		onRefresh: handlePullRefresh,
		onExport: changes.length || recoveryChanges.length ? () => exportPendingChanges([...changes, ...recoveryChanges]) : undefined,
		onEnablePush: enablePushNotifications,
		onLogout: logOut,
		clearView: resetView,
		recovery: <ReminderRecoveryNotices recoveryChanges={recoveryChanges} quarantinedChanges={quarantinedChanges} folderPath={config.folderPath}
			onResume={enabled ? recoverChanges : undefined} onRemove={removeQuarantinedChanges} />,
	});

	return {
		connection: { authToken, bootstrapped, config, selectedProject, setSelectedProject, startTab, launchReminderId, setLaunchReminderId },
		sync: reminderSync,
		mutations,
		editor: { ...editor, ...editorActions },
		status,
		presentation: {
			colorScheme, isDarkMode, settingsOpen, toggleSettings, reorderDragging, setReorderDragging,
			showToast, handlePullRefresh, initialContentReady, sharedReminders, resolvePageTitle,
		},
		enablePushNotifications,
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
