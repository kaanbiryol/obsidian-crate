import { PWA_ASSET_VERSION } from '@/cloudflare/worker/pwa-version';
import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
	PwaRemindersAppShell,
	type PwaReminderCardRenderer,
} from './components/PwaRemindersAppShell';
import {
	AUTH_TOKEN_KEY,
	loadStoredConfig,
} from './config';
import {
	makeApiFetch,
	registerPwaServiceWorker,
} from './api';
import { ErrorState, EmptyAuthState } from './components/AuthStates';
import { PwaHeaderActions, PwaLaunchSplash, PwaPullRefreshIndicator, PwaTopNotices } from './components/PwaChrome';
import { WebReminderCard } from './components/WebReminderCard';
import { ReminderSyncNotice } from './components/ReminderSyncNotice';
import { ReminderRecoveryNotice } from './components/ReminderRecoveryNotice';
import { ReminderSourceNotice } from './components/ReminderSourceNotice';
import { ReminderCacheNotice } from './components/ReminderCacheNotice';
import { usePushNotifications } from './hooks/usePushNotifications';
import { usePwaBootstrap } from './hooks/usePwaBootstrap';
import { usePwaColorScheme } from './hooks/usePwaColorScheme';
import { usePwaRefreshLifecycle } from './hooks/usePwaRefreshLifecycle';
import { usePwaUpdate } from './hooks/usePwaUpdate';
import { usePwaSessionLifecycle } from './hooks/usePwaSessionLifecycle';
import { usePwaStatus } from './hooks/usePwaStatus';
import { useLaunchReminderModal } from './hooks/useLaunchReminderModal';
import { useReminderSync } from './hooks/useReminderSync';
import { useReminderMutations } from './hooks/useReminderMutations';
import { useSheetTransition } from './hooks/useSheetTransition';
import { useToast } from './hooks/useToast';
import { useHomeScreenInstall } from './hooks/useHomeScreenInstall';
import { HomeScreenInstallPrompt } from './components/HomeScreenInstall';
import { loadPwaPreferences, savePwaPreferences, type PwaPreferences } from './preferences';
import { isInitialPwaContentReady } from './initial-content-readiness';
import { toSharedReminder } from './reminder-list-state';
import { buildModalDraft } from './reminder-modal-draft';
import type {
	ModalMode,
	ModalState,
	StartTab,
	StoredConfig,
} from './types';

// Keep the editor ready for the tap's synchronous focus/keyboard activation.
import { ReminderSheet } from './components/ReminderSheet';
const SettingsSheet = lazy(() => import('./components/SettingsSheet')
	.then(module => ({ default: module.SettingsSheet })));

function App() {
	const { colorScheme, themePreference, setThemePreference } = usePwaColorScheme();
	const isDarkMode = colorScheme === 'dark';
	const [authToken, setAuthToken] = useState<string | null>(() => localStorage.getItem(AUTH_TOKEN_KEY));
	const [bootstrapped, setBootstrapped] = useState(false);
	const [storedConfig, setConfig] = useState<StoredConfig>(() => loadStoredConfig());
	const [preferences, setPreferences] = useState(loadPwaPreferences);
	const config = useMemo(() => ({ ...storedConfig, upcomingDays: preferences.upcomingDays ?? storedConfig.upcomingDays }), [storedConfig, preferences.upcomingDays]);
	const [selectedProject, setSelectedProject] = useState<string | null>(null);
	const [startTab, setStartTab] = useState<StartTab>(() => preferences.defaultScreen);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [launchReminderId, setLaunchReminderId] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [modal, setModal] = useState<ModalState | null>(null);
	const [reorderDragging, setReorderDragging] = useState(false);
	const { toast, showToast } = useToast();
	const homeScreenInstall = useHomeScreenInstall();
	const { updating, update } = usePwaUpdate(showToast);
	const handleUnauthorizedRef = useRef<() => void>(() => undefined);
	const finalizeModalClose = useCallback(() => setModal(null), []);
	const finalizeSettingsClose = useCallback(() => setSettingsOpen(false), []);
	const modalTransition = useSheetTransition(finalizeModalClose);
	const settingsTransition = useSheetTransition(finalizeSettingsClose);

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
		() => makeApiFetch(authToken, () => handleUnauthorizedRef.current()),
		[authToken],
	);
	const reminderSync = useReminderSync({ apiFetch, authToken, bootstrapped, config, setSelectedProject });
	const {
		push,
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
		remindersRef,
		projectsRef,
		hydratedCacheRef,
		hydrateCachedSnapshot,
		loadReminders,
		rebuildOfflineCache,
		beginLocalMutation,
		commitReminderState,
		resetReminderState,
		setReminders,
		setProjects,
		setLoading,
		setError,
	} = reminderSync;
	const initialContentReady = isInitialPwaContentReady({
		authToken,
		bootstrapped,
		loading,
	});
	const { loggingOut, logOut, suspendLocalSession } = usePwaSessionLifecycle({
		apiFetch,
		cancelModalClose: modalTransition.cancelClose,
		cancelSettingsClose: settingsTransition.cancelClose,
		disablePushNotifications,
		handleUnauthorizedRef,
		resetReminderState,
		setAuthToken,
		setConfig,
		setError,
		setModal,
		setSettingsOpen,
		showToast,
	});

	usePwaBootstrap({
		authToken,
		suspendLocalSession,
		hydrateCachedSnapshot,
		hydratedCacheRef,
		setAuthToken,
		setBootstrapped,
		setConfig,
		setError,
		setLaunchReminderId,
		setLoading,
		setSelectedProject,
		setStartTab,
		showToast,
	});

	const updateAvailable = usePwaRefreshLifecycle({
		authToken,
		bootstrapped,
		hydratedCacheRef,
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

	const closeModal = useCallback(() => {
		if (!modal) return;
		setSaving(false);
		modalTransition.requestClose();
	}, [modal, modalTransition.requestClose]);

	const toggleSettings = useCallback(() => {
		if (settingsOpen) {
			settingsTransition.requestClose();
			return;
		}
		settingsTransition.cancelClose();
		setSettingsOpen(true);
	}, [settingsOpen, settingsTransition.cancelClose, settingsTransition.requestClose]);

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
		storageError,
		retryInitialization,
		recoveryChanges,
		recoverChanges,
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
		projectsRef,
		remindersRef,
		selectedProject,
		setProjects,
		setReminders,
		setSaving,
		showToast,
	});

	const launchChange = changes.find(change => launchReminderId && (change.recordId === launchReminderId || change.optimistic?.id === launchReminderId));
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
		setModal,
		setSaving,
		setSelectedProject,
		setSettingsOpen,
		showToast,
	});

	const openModal = useCallback((mode: ModalMode, reminderId?: string, defaultProject?: string) => {
		if (!mutationsReady || !ensureCanMutate()) return;
		if (reminderId && changes.some(change => change.status !== 'failed'
			&& (change.recordId === reminderId || change.optimistic?.id === reminderId))) {
			showToast('info', 'This reminder is still syncing. Retry its pending change first.');
			return;
		}
		const reminder = reminderId ? visibleReminders.find((item) => item.id === reminderId) ?? null : null;
		settingsTransition.cancelClose();
		modalTransition.cancelClose();
		setSettingsOpen(false);
		setSaving(false);
		flushSync(() => {
			setModal({ mode, reminderId, expectedRevision: reminder?.revision, filePath: reminder?.filePath, operationId: crypto.randomUUID(), draft: buildModalDraft(reminder, defaultProject ?? selectedProject) });
		});
	}, [changes, ensureCanMutate, modalTransition.cancelClose, mutationsReady, visibleReminders, selectedProject, settingsTransition.cancelClose, showToast]);

	const editFailedChange = useCallback((operationId: string) => {
		if (!mutationsReady || !ensureCanMutate()) return;
		const draft = prepareEdit(operationId);
		if (!draft) return;
		settingsTransition.cancelClose();
		modalTransition.cancelClose();
		setSettingsOpen(false);
		setSaving(false);
		flushSync(() => setModal(draft));
	}, [ensureCanMutate, modalTransition.cancelClose, mutationsReady, prepareEdit, settingsTransition.cancelClose]);

	const updatePreferences = (patch: Partial<PwaPreferences>) => {
		const next = { ...preferences, ...patch };
		try {
			savePwaPreferences(next);
			setPreferences(next);
		} catch {
			showToast('error', 'Could not save settings on this device.');
		}
	};

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

	if (!initialContentReady) {
		return <PwaLaunchSplash />;
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
				reminders={sharedReminders}
				projects={visibleProjects}
				incomplete={issues.length > 0}
				isDarkMode={isDarkMode}
				initialTab={selectedProject ? 'browse' : startTab}
				initialProject={selectedProject ?? undefined}
				upcomingDays={config.upcomingDays}
				className="app-shell pwa-reminders-view"
				headerRightContent={authToken ? (
					<PwaHeaderActions
						settingsOpen={settingsOpen}
						onToggleSettings={toggleSettings}
					/>
				) : undefined}
				belowHeaderContent={bootstrapped && authToken ? (isProjectDetail) => (
					<>
						<PwaPullRefreshIndicator
							enabled={Boolean(!loading && !modal && !settingsOpen && !reorderDragging)}
							onRefresh={handlePullRefresh}
						/>
						<PwaTopNotices
							statusText={statusText}
							statusKind={statusKind}
							updateAvailable={updateAvailable}
							updating={updating}
							showNotificationPrompt={canShowNotificationPrompt && !isProjectDetail}
							onReload={update}
							onEnableNotifications={enablePushNotifications}
						>
							<ReminderSourceNotice issues={issues} refreshing={refreshing} isOffline={isOffline} onRefresh={() => { void loadReminders({ silent: true }); }} />
							<ReminderCacheNotice isOffline={isOffline} onRebuild={rebuildOfflineCache} />
							<ReminderSyncNotice
								changes={changes}
								isOffline={isOffline}
								storageError={storageError}
								onRetryInitialization={retryInitialization}
								onRetry={retryChange}
								onEdit={editFailedChange}
								onDiscard={discardChange}
							/>
							<ReminderRecoveryNotice changes={recoveryChanges} folderPath={config.folderPath} onResume={recoverChanges} />
							{homeScreenInstall.showPrompt && !isProjectDetail && (
								<HomeScreenInstallPrompt onShowSteps={toggleSettings} onDismiss={homeScreenInstall.dismiss} />
							)}
						</PwaTopNotices>
					</>
				) : undefined}
				suppressFab={Boolean(modal) || settingsOpen || readOnly || !mutationsReady}
				renderCard={renderSharedCard}
				onAdd={(defaultProject) => openModal('create', undefined, defaultProject)}
				onReorder={persistReorder}
				onReorderDragActiveChange={setReorderDragging}
			>
				{settingsOpen && (
					<Suspense fallback={null}><SettingsSheet
						config={config}
						homeScreenPlatform={homeScreenInstall.platform}
						defaultScreen={preferences.defaultScreen}
						onPreferencesChange={updatePreferences}
						push={push}
						themePreference={themePreference}
						loggingOut={loggingOut}
						isClosing={settingsTransition.isClosing}
						onClose={settingsTransition.requestClose}
						onClosed={settingsTransition.finishClose}
						onEnablePush={enablePushNotifications}
						onThemePreferenceChange={setThemePreference}
						onLogout={() => void logOut()}
					/></Suspense>
				)}
				{modal && (
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
				)}
				{toast && (
					<div
						className={`toast is-${toast.kind}`}
						role={toast.kind === 'error' ? 'alert' : 'status'}
						aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
					>
						{toast.message}
					</div>
				)}
			</PwaRemindersAppShell>
		</div>
	);
}

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root');
createRoot(root).render(<App />);
