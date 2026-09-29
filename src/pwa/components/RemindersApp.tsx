import { PwaToast } from './PwaToast';
import { FeatureNavigationContext } from './FeatureSwitcherButton';
import { PWA_ASSET_VERSION } from '@/cloudflare/worker/pwa-version';
import { PageTitleContext } from '@/reminders/components/lexical/pageTitles';
import React, { lazy, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
	PwaRemindersAppShell,
	type PwaReminderCardRenderer,
} from './PwaRemindersAppShell';
import {
	AUTH_TOKEN_KEY,
	isStandaloneApp,
	loadStoredConfig,
} from '../config';
import {
	makeApiFetch,
	registerPwaServiceWorker,
} from '../api';
import { ErrorState, EmptyAuthState } from './AuthStates';
import { PwaHeaderActions, PwaLaunchSplash, PwaPullRefreshIndicator, PwaTopNotices } from './PwaChrome';
import { WebReminderCard } from './WebReminderCard';
import { PwaSyncIndicator, reminderSyncStatus } from './PwaSyncIndicator';
import { exportPendingChanges } from '../export-pending-changes';
import { ReminderSourceNotice } from './ReminderSourceNotice';
import { ReminderCacheNotice } from './ReminderCacheNotice';
import { DeferredNotice } from './DeferredNotice';
import { usePushNotifications } from '../hooks/usePushNotifications';
import { usePwaBootstrap } from '../hooks/usePwaBootstrap';
import { usePwaColorScheme } from '../hooks/usePwaColorScheme';
import { usePwaRefreshLifecycle } from '../hooks/usePwaRefreshLifecycle';
import { useAppUpdate } from './PwaUpdateProvider';
import { usePwaSessionLifecycle } from '../hooks/usePwaSessionLifecycle';
import { usePwaStatus } from '../hooks/usePwaStatus';
import { useLaunchReminderModal } from '../hooks/useLaunchReminderModal';
import { useReminderSync } from '../hooks/useReminderSync';
import { useReminderMutations } from '../hooks/useReminderMutations';
import { useReminderEditor } from '../hooks/useReminderEditor';
import { usePrepareReminderEditor } from '../hooks/usePrepareReminderEditor';
import { useToast } from '../hooks/useToast';
import { useHomeScreenInstall } from '../hooks/useHomeScreenInstall';
import { HomeScreenInstallPrompt } from './HomeScreenInstall';
import { usePwaPreferences } from '../hooks/usePwaPreferences';
import { useFeatureSettings, useSettingsOpen } from '../settings-context';
import { isInitialPwaContentReady } from '../initial-content-readiness';
import { toSharedReminder } from '../reminder-list-state';
import type {
	ModalMode,
	StartTab,
	StoredConfig,
} from '../types';

// Keep the editor ready for the tap's synchronous focus/keyboard activation.
import { ReminderSheet } from './ReminderSheet';
const ReminderSyncNotice = lazy(() => import('./ReminderSyncNotice')
	.then(module => ({ default: module.ReminderSyncNotice })));
const ReminderRecoveryNotice = lazy(() => import('./ReminderRecoveryNotice')
	.then(module => ({ default: module.ReminderRecoveryNotice })));
const ReminderQuarantineNotice = lazy(() => import('./ReminderQuarantineNotice')
	.then(module => ({ default: module.ReminderQuarantineNotice })));

export function RemindersApp() {
	const active = useContext(FeatureNavigationContext)?.active !== false;
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
	const { toast, showToast } = useToast();
	const homeScreenInstall = useHomeScreenInstall();
	const handleUnauthorizedRef = useRef<() => void>(() => undefined);


	useEffect(() => {
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
	}, [showToast]);

	const apiFetch = useMemo(
		() => makeApiFetch(authSession.token, () => handleUnauthorizedRef.current()),
		[authSession],
	);
	const reminderSync = useReminderSync({ apiFetch, authToken, config, setSelectedProject });
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
	} = usePushNotifications({ authToken, apiFetch, showToast });
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
		if (!readOnlyMessage) return true;
		showToast('info', readOnlyMessage);
		return false;
	}, [readOnlyMessage, showToast]);

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
		hasSnapshot: lastUpdatedAt !== null,
		canRecover: !readOnly,
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

	const { version: updateVersion, launchPending } = useAppUpdate();

	const launchChange = changes.find(change => launchReminderId && (change.recordId === launchReminderId || change.optimistic?.id === launchReminderId));
	usePrepareReminderEditor(initialContentReady && !launchPending && Boolean(authToken)
		&& !modal && !settingsOpen && !launchReminderId);
	useLaunchReminderModal({
		authToken,
		bootstrapped,
		dataMode,
		isOffline,
		launchReminderId,
		loading: loading || !mutationsReady,
		readOnlyMessage: readOnlyMessage || (launchChange
			? 'Use the sync notice to finish this reminder’s pending change before editing.' : null),
		refreshing,
		reminders: visibleReminders,
		selectedProject,
		setLaunchReminderId,
		openReminder,
		setSelectedProject,
		showToast,
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
	const renderSharedCard = useCallback<PwaReminderCardRenderer>(({ reminder, index, hideProject }) => (
		<WebReminderCard
			key={`${reminder.id}-${reminder.dueDate || reminder.dueDatetime || ''}`}
			reminder={reminder}
			index={index}
			hideProject={hideProject}
			onEdit={editReminder}
			onToggleComplete={toggleReminderCompleted}
		/>
	), [editReminder, toggleReminderCompleted]);

	const syncStatus = reminderSyncStatus({ changes, isOffline, refreshing, loading, dataMode, error, storageError });
	const needsRecovery = recoveryChanges.length > 0 || quarantinedChanges.length > 0;
	useFeatureSettings('reminders', {
		ready: bootstrapped && (mutationsReady || Boolean(storageError) || !authToken),
		connected: Boolean(authToken), config, push,
		updateContentReady: initialContentReady,
		updateReady: bootstrapped && (!authToken || (initialContentReady && mutationsReady
			&& !modal && !saving && !loggingOut && !reorderDragging
			&& !launchReminderId && !loading && !refreshing && !isOffline
			&& !storageError && changes.length === 0 && recoveryChanges.length === 0
			&& quarantinedChanges.length === 0 && !isPreparingMutation())),
		status: syncStatus,
		attention: needsRecovery ? 'Saved reminder changes need review.' : syncStatus.state === 'error' ? syncStatus.label : null,
		unsynced: changes.length > 0 || needsRecovery || Boolean(storageError),
		onRefresh: handlePullRefresh,
		onExport: changes.length || recoveryChanges.length ? () => exportPendingChanges([...changes, ...recoveryChanges]) : undefined,
		onEnablePush: enablePushNotifications,
		onLogout: logOut,
		recovery: <>
			{recoveryChanges.length > 0 && <DeferredNotice><ReminderRecoveryNotice changes={recoveryChanges} folderPath={config.folderPath} onResume={recoverChanges} /></DeferredNotice>}
			{quarantinedChanges.length > 0 && <DeferredNotice><ReminderQuarantineNotice entries={quarantinedChanges} folderPath={config.folderPath} onRemove={removeQuarantinedChanges} /></DeferredNotice>}
		</>,
	});

	// Resolve the launch destination first, then keep the real chrome mounted
	// while data, pending changes, and notification state finish loading.
	if (!bootstrapped || launchPending) {
		return <PwaLaunchSplash updating={launchPending && Boolean(updateVersion)} />;
	}

	if (bootstrapped && !authToken) {
		return (
			<div>
				{error
					? <ErrorState error={error} config={config} onRetry={() => window.location.reload()} />
					: <EmptyAuthState config={config} />}
			</div>
		);
	}

	return (
		<div
			className={`crate-reminders-ui reminders-shadow-root pwa-shadow-root ${colorScheme}${modal || settingsOpen ? ' has-open-sheet' : ''}`}
			data-ui-host="pwa"
		>
			<PwaRemindersAppShell
				key={`pwa-shell-${selectedProject ?? startTab}`}
				initializing={!initialContentReady}
				reminders={initialContentReady ? sharedReminders : []}
				projects={initialContentReady ? visibleProjects : []}
				incomplete={issues.length > 0}
				checkingReminders={!initialContentReady || loading || refreshing || (dataMode === 'cached' && !isOffline && !error)}
				showLoadingIndicator={!initialContentReady || (sharedReminders.length === 0 && (loading || (dataMode === 'cached' && !isOffline && !error)))}
				isDarkMode={isDarkMode}
				initialTab={selectedProject ? 'browse' : startTab}
				initialProject={selectedProject ?? undefined}
				upcomingDays={config.upcomingDays}
				className="app-shell pwa-reminders-view"
				headerRightContent={authToken ? (isProjectDetail) => (
					<PwaHeaderActions
						settingsOpen={settingsOpen}
						onToggleSettings={toggleSettings}
						showSettings={!isProjectDetail}
					>
						<PwaSyncIndicator
							onShowStatus={(label, state) => showToast(state === 'error' ? 'error' : state === 'synced' ? 'success' : 'info', `Sync across all projects: ${label}`, state)}
							changes={changes}
							isOffline={isOffline}
							refreshing={refreshing}
							loading={loading}
							dataMode={dataMode}
							error={error}
							storageError={storageError}
						/>
					</PwaHeaderActions>
				) : undefined}

				belowHeaderContent={initialContentReady && authToken ? (isProjectDetail) => (
					<>
						<PwaPullRefreshIndicator
							enabled={Boolean(!loading && !modal && !settingsOpen && !reorderDragging)}
							onRefresh={handlePullRefresh}
						/>
						<PwaTopNotices
							statusText={statusText}
							statusKind={statusKind}
							showNotificationPrompt={canShowNotificationPrompt && !isProjectDetail}
							onEnableNotifications={enablePushNotifications}
						>
							<ReminderSourceNotice issues={issues} refreshing={refreshing} isOffline={isOffline} onRefresh={() => { void loadReminders({ silent: true }); }} />
							<ReminderCacheNotice isOffline={isOffline} onRebuild={rebuildOfflineCache} />
							{(changes.some(change => change.status !== 'pending') || storageError) && <DeferredNotice><ReminderSyncNotice
								changes={changes}
								isOffline={isOffline}
								storageError={storageError}
								onRetryInitialization={retryInitialization}
								onRetry={retryChange}
								onEdit={editFailedChange}
								onDiscard={discardChange}
							/></DeferredNotice>}
							{recoveryChanges.length > 0 && <DeferredNotice><ReminderRecoveryNotice changes={recoveryChanges} folderPath={config.folderPath} onResume={recoverChanges} /></DeferredNotice>}
							{quarantinedChanges.length > 0 && <DeferredNotice><ReminderQuarantineNotice entries={quarantinedChanges} folderPath={config.folderPath} onRemove={removeQuarantinedChanges} /></DeferredNotice>}
							{homeScreenInstall.showPrompt && !isProjectDetail && (
								<HomeScreenInstallPrompt onShowSteps={toggleSettings} onDismiss={homeScreenInstall.dismiss} />
							)}
						</PwaTopNotices>
					</>
				) : undefined}
				suppressFab={readOnly || !mutationsReady}
				backgroundInert={Boolean(modal) || settingsOpen}
				renderCard={renderSharedCard}
				onAdd={(defaultProject) => openModal('create', undefined, defaultProject)}
				onReorder={persistReorder}
				onReorderDragActiveChange={setReorderDragging}
			>
				{modal && active && !settingsOpen && (
					<PageTitleContext.Provider value={resolvePageTitle}>
						<ReminderSheet
							key={`${modal.mode}-${modal.reminderId ?? 'new'}-${modal.operationId ?? ''}`}
							colorScheme={colorScheme}
							modal={modal}
							folderPath={config.folderPath}
							projects={visibleProjects}
							saving={saving}
							isClosing={modalTransition.isClosing}
							onClose={closeModal}
							onClosed={modalTransition.finishClose}
							onSave={saveReminder}
							onDelete={deleteReminder}
						/>
					</PageTitleContext.Provider>
				)}
				<PwaToast toast={toast} />
			</PwaRemindersAppShell>
		</div>
	);
}
