import { encryptionSnapshot, subscribeEncryption } from '../encryption-session';
import { PWA_ASSET_VERSION } from '@/cloudflare/worker/pwa-version';
import type { Dispatch, SetStateAction } from 'react';
import { createContext, lazy, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
	makeApiFetch,
	registerPwaServiceWorker,
} from '../api';
import {
	AUTH_TOKEN_KEY,
	isStandaloneApp,
	loadStoredConfig,
} from '../config';
import { exportPendingChanges } from '../export-pending-changes';
import { useHomeScreenInstall } from '../hooks/useHomeScreenInstall';
import { usePushNotifications } from '../hooks/usePushNotifications';
import { usePwaBootstrap } from '../hooks/usePwaBootstrap';
import { usePwaColorScheme } from '../hooks/usePwaColorScheme';
import { usePwaPreferences } from '../hooks/usePwaPreferences';
import { usePwaRefreshLifecycle } from '../hooks/usePwaRefreshLifecycle';
import { usePwaSessionLifecycle } from '../hooks/usePwaSessionLifecycle';
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
	StartTab,
	StoredConfig,
} from '../types';
import { DeferredNotice } from './DeferredNotice';
import { reminderSyncStatus } from '../sync/reminder-status';

const ReminderRecoveryNotice = lazy(() => import('./ReminderRecoveryNotice')
	.then(module => ({ default: module.ReminderRecoveryNotice })));
const ReminderQuarantineNotice = lazy(() => import('./ReminderQuarantineNotice')
	.then(module => ({ default: module.ReminderQuarantineNotice })));


function useRemindersController() {
	const enabled = useSharedFeatures().reminders;
	const encryption = useSyncExternalStore(subscribeEncryption, encryptionSnapshot);
	const { colorScheme } = usePwaColorScheme();
	const isDarkMode = colorScheme === 'dark';
	const [authSession, setAuthSession] = useState(() => ({ token: localStorage.getItem(AUTH_TOKEN_KEY) }));
	const authToken = authSession.token;
	const setAuthToken = useCallback<Dispatch<SetStateAction<string | null>>>((next) => {
		// React may batch a clear and re-enrollment with the same token. Retain
		// the new session identity so its API client captures the new authority.
		setAuthSession(current => ({ token: typeof next === 'function' ? next(current.token) : next }));
	}, []);
	const [bootstrapped, setBootstrapped] = useState(false);
	const [storedConfig, setConfig] = useState<StoredConfig>(() => loadStoredConfig());
	const { preferences } = usePwaPreferences();
	const config = useMemo(() => ({ ...storedConfig, upcomingDays: preferences.upcomingDays ?? storedConfig.upcomingDays }), [storedConfig, preferences.upcomingDays]);
	const [selectedProject, setSelectedProject] = useState<string | null>(null);
	const [startTab, setStartTab] = useState<StartTab>(() => ['today', 'inbox', 'upcoming', 'browse'].includes(preferences.defaultScreen) ? preferences.defaultScreen as StartTab : 'today');
	const [settingsOpen, setSettingsOpen] = useSettingsOpen();
	const [launchReminderId, setLaunchReminderId] = useState<string | null>(null);
	const { modal, saving, setSaving, transition: modalTransition, closeModal, resetEditor, openEditor, openReminder } = useReminderEditor(setSettingsOpen);
	const [reorderDragging, setReorderDragging] = useState(false);
	const showToast = useSyncFeedback();
	const homeScreenInstall = useHomeScreenInstall();
	const handleUnauthorizedRef = useRef<() => void>(() => undefined);


	useEffect(() => {
		if (!bootstrapped) return;
		const reportVersion = () => navigator.serviceWorker?.controller?.postMessage({ type: 'CRATE_CLIENT_VERSION', version: PWA_ASSET_VERSION });
		navigator.serviceWorker?.addEventListener('controllerchange', reportVersion);
		document.addEventListener('visibilitychange', reportVersion);
		void registerPwaServiceWorker().then(reportVersion).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			showToast('error', `Offline support could not start: ${message}`);
		});
		return () => {
			navigator.serviceWorker?.removeEventListener('controllerchange', reportVersion);
			document.removeEventListener('visibilitychange', reportVersion);
		};
	}, [bootstrapped, showToast]);

	const apiFetch = useMemo(
		() => makeApiFetch(authSession.token, () => handleUnauthorizedRef.current()),
		[authSession],
	);
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
	const { loggingOut, logOut, suspendLocalSession } = usePwaSessionLifecycle({
		apiFetch,
		resetEditor,
		disablePushNotifications,
		handleUnauthorizedRef,
		resetReminderState,
		setAuthToken,
		setConfig,
		reportError,
		setSettingsOpen,
		showToast,
	});

	usePwaBootstrap({
		authToken,
		suspendLocalSession,
		hydrateCachedSnapshot,
		setAuthToken,
		setBootstrapped,
		setConfig,
		reportError,
		setLaunchReminderId,
		resetReminderState,
		setSelectedProject,
		setStartTab,
		showToast,
	});

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
		retryAt: Math.min(...changes.filter(change => change.status === 'uncertain' && change.attempts < 3).map(change => change.retryAt)),
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
		clearView: () => { resetEditor(); resetReminderState(); setAuthToken(null); },
		recovery: <>
			{recoveryChanges.length > 0 && <DeferredNotice><ReminderRecoveryNotice changes={recoveryChanges} folderPath={config.folderPath} onResume={enabled ? recoverChanges : undefined} /></DeferredNotice>}
			{quarantinedChanges.length > 0 && <DeferredNotice><ReminderQuarantineNotice entries={quarantinedChanges} folderPath={config.folderPath} onRemove={removeQuarantinedChanges} /></DeferredNotice>}
		</>,
	});

	return {
		encryption, logOut, loggingOut, colorScheme, isDarkMode, authToken, bootstrapped, config, selectedProject,
		setSelectedProject, startTab, settingsOpen, launchReminderId, setLaunchReminderId, modal,
		saving, modalTransition, closeModal, openReminder, reorderDragging, setReorderDragging,
		showToast, homeScreenInstall, loading, refreshing, error,
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
