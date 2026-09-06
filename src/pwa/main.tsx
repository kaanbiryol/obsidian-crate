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
	} = usePushNotifications({ apiFetch, showToast });
	const {
		reminders,
		projects,
		loading,
		refreshing,
		error,
		dataMode,
		lastUpdatedAt,
		isOffline,
		remindersRef,
		projectsRef,
		hydratedCacheRef,
		hydrateCachedSnapshot,
		loadReminders,
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
	const { loggingOut, logOut } = usePwaSessionLifecycle({
		apiFetch,
		cancelModalClose: modalTransition.cancelClose,
		cancelSettingsClose: settingsTransition.cancelClose,
		disablePushNotifications,
		handleUnauthorizedRef,
		resetReminderState,
		setAuthToken,
		setError,
		setModal,
		setSettingsOpen,
		showToast,
	});

	usePwaBootstrap({
		authToken,
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

	useLaunchReminderModal({
		authToken,
		bootstrapped,
		dataMode,
		isOffline,
		launchReminderId,
		loading,
		readOnlyMessage,
		refreshing,
		reminders,
		selectedProject,
		setLaunchReminderId,
		setModal,
		setSaving,
		setSelectedProject,
		setSettingsOpen,
		showToast,
	});

	const openModal = useCallback((mode: ModalMode, reminderId?: string, defaultProject?: string) => {
		if (!ensureCanMutate()) return;
		const reminder = reminderId ? reminders.find((item) => item.id === reminderId) ?? null : null;
		settingsTransition.cancelClose();
		modalTransition.cancelClose();
		setSettingsOpen(false);
		setSaving(false);
		flushSync(() => {
			setModal({ mode, reminderId, expectedRevision: reminder?.revision, filePath: reminder?.filePath, operationId: crypto.randomUUID(), draft: buildModalDraft(reminder, defaultProject ?? selectedProject) });
		});
	}, [ensureCanMutate, modalTransition.cancelClose, reminders, selectedProject, settingsTransition.cancelClose]);

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
	} = useReminderMutations({
		apiFetch,
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

	const updatePreferences = (patch: Partial<PwaPreferences>) => {
		const next = { ...preferences, ...patch };
		try {
			savePwaPreferences(next);
			setPreferences(next);
		} catch {
			showToast('error', 'Could not save settings on this device.');
		}
	};

	const sharedReminders = useMemo(() => reminders.map(toSharedReminder), [reminders]);
	const editReminder = useCallback((id: string) => openModal('edit', id), [openModal]);
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
				projects={projects}
				isDarkMode={isDarkMode}
				initialTab={selectedProject ? 'browse' : startTab}
				initialProject={selectedProject ?? undefined}
				upcomingDays={config.upcomingDays}
				className="app-shell pwa-reminders-view"
				headerRightContent={authToken ? (
					<PwaHeaderActions
						settingsOpen={settingsOpen}
						statusText={statusText}
						statusKind={statusKind}
						refreshing={refreshing}
						onRefresh={() => void loadReminders({ silent: true })}
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
						/>
					</>
				) : undefined}
				suppressFab={Boolean(modal) || settingsOpen || readOnly}
				renderCard={renderSharedCard}
				onAdd={(defaultProject) => openModal('create', undefined, defaultProject)}
				onReorder={persistReorder}
				onReorderDragActiveChange={setReorderDragging}
			>
				{settingsOpen && (
					<Suspense fallback={null}><SettingsSheet
						config={config}
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
						key={`${modal.mode}-${modal.reminderId ?? 'new'}`}
						colorScheme={colorScheme}
						modal={modal}
						projects={projects}
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
