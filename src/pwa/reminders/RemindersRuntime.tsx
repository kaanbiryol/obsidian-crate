import { reminderUpdateReadiness } from '../update/update-readiness';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isStandaloneApp } from '../config';
import { useAppConnection, useConnectionReset } from '../connection/AppConnection';
import { usePushNotifications } from './usePushNotifications';
import { usePwaColorScheme } from '../hooks/usePwaColorScheme';
import { usePwaPreferences } from '../settings/usePwaPreferences';
import { usePwaRefreshLifecycle } from './usePwaRefreshLifecycle';
import { usePwaStatus } from './usePwaStatus';
import { useReminderEditorActions } from './editor/useReminderEditorActions';
import { useReminderEditor } from './editor/useReminderEditor';
import { useReminderMutations } from './useReminderMutations';
import { useReminderSync } from './useReminderSync';
import { fetchPageTitle } from './reminder-api';
import { useSyncFeedback } from '../sync/SyncFeedback';
import { isInitialPwaContentReady } from './initial-content-readiness';
import { useSharedFeatures } from '../shared-features';
import { toSharedReminder } from './outbox/reminder-list-state';
import { useFeatureSettings, useSettingsOpen } from '../settings/settings-context';
import { ReminderRecoveryNotices } from './notices/ReminderRecoveryNotices';
import { reminderFeatureStatus, reminderSyncStatus } from '../sync/reminder-status';
import { reminderNeedsAttention, reminderRetryAt } from './outbox/reminder-outbox';
import type { PendingReminderChange } from './outbox/reminder-outbox-types';
import { downloadJson } from '../storage/download';

/** Review copy only; importing it must never silently mint fresh operation IDs. */
function exportPendingChanges(changes: PendingReminderChange[]): void {
	downloadJson('crate-pending-changes.json', { format: 'crate-pending-reminder-changes-v1', origin: location.origin, changes });
}

function useRemindersController() {
	const enabled = useSharedFeatures().reminders;
	const connection = useAppConnection();
	const { authority, authToken, apiFetch, config: storedConfig, logOut, loggingOut, encryption,
		selectedProject, setSelectedProject, startTab, launchReminderId, setLaunchReminderId, registerPushCleanup } = connection;
	// An unanswered check on a device without encryption evidence shows the plaintext
	// offline copy read-only. The outbox stays locked, so it cannot hold back the list.
	const unavailableMessage = encryption.status === 'locked' && encryption.offlineCopy ? encryption.message : null;
	const { colorScheme } = usePwaColorScheme();
	const isDarkMode = colorScheme === 'dark';
	const { preferences } = usePwaPreferences();
	const config = useMemo(() => ({ ...storedConfig, upcomingDays: preferences.upcomingDays ?? storedConfig.upcomingDays }), [storedConfig, preferences.upcomingDays]);
	const [settingsOpen, setSettingsOpen] = useSettingsOpen();
	const editor = useReminderEditor(setSettingsOpen);
	const { modal, saving, resetEditor } = editor;
	const [reorderDragging, setReorderDragging] = useState(false);
	const showToast = useSyncFeedback();
	const reminderSync = useReminderSync({ apiFetch, authToken, authority, bootstrapped: connection.bootstrapped, config,
		prepareSession: apiFetch.ready, onSignedOut: resetEditor, setSelectedProject, enabled });
	const bootstrapped = connection.bootstrapped && reminderSync.hydrated;
	const resolvePageTitle = useCallback((url: string) => fetchPageTitle(apiFetch, url), [apiFetch]);
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
		hasHydratedCache,
		loadReminders,
		resetReminderState,
		refreshPresentation,
	} = reminderSync;
	const resetView = useCallback(() => { resetEditor(); resetReminderState(); }, [resetEditor, resetReminderState]);
	useConnectionReset(resetView);
	useEffect(() => registerPushCleanup(disablePushNotifications), [registerPushCleanup, disablePushNotifications]);

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


	const toggleSettings = useCallback(() => setSettingsOpen(open => !open), [setSettingsOpen]);

	const mutations = useReminderMutations({
		enabled,
		hasSnapshot: lastUpdatedAt !== null,
		canRecover: enabled && !readOnly,
		apiFetch,
		authToken,
		bootstrapped,
		sync: reminderSync,
		reminders,
		config,
		ensureCanMutate,
		projects,
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

	const { resumeChanges } = mutations;
	// An explicit refresh also resends changes paused after their automatic retries.
	const handlePullRefresh = useCallback(() => { resumeChanges(); return loadReminders({ silent: true }); }, [resumeChanges, loadReminders]);

	const initialContentReady = isInitialPwaContentReady({
		notificationPromptReady: !isStandaloneApp() || initialCheckComplete,
		authToken,
		bootstrapped,
		loading,
		pendingChangesReady: mutationsReady || Boolean(storageError) || unavailableMessage !== null,
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
			// A paused feature sends nothing, so its queue waits like a rejected change.
			editing: Boolean(modal), stalled: Boolean(storageError) || needsRecovery
				|| changes.some(change => !enabled || reminderNeedsAttention(change)),
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
		connection: { authToken, bootstrapped, config, selectedProject, setSelectedProject, startTab, launchReminderId, setLaunchReminderId, unavailableMessage },
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
