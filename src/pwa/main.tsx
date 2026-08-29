import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { RemindersAppShell, type ReminderCardRenderer } from '@/reminders/ui/RemindersAppShell';
import { PWA_ASSET_VERSION } from '@/cloudflare/worker/pwa-version';
import {
	AUTH_TOKEN_KEY,
	REMINDERS_CACHE_KEY,
	isStandaloneApp,
	loadStoredConfig,
} from './config';
import {
	fetchPwaAssetVersion,
	makeApiFetch,
	registerPwaServiceWorker,
	replaceBrowserUrlWithInstallToken,
} from './api';
import { ErrorState, EmptyAuthState } from './components/AuthStates';
import { PwaHeaderActions, PwaLoadingSkeleton, PwaPullRefreshIndicator, PwaTopNotices } from './components/PwaChrome';
import { ReminderSheet } from './components/ReminderSheet';
import { SettingsSheet } from './components/SettingsSheet';
import { WebReminderCard } from './components/WebReminderCard';
import { usePushNotifications } from './hooks/usePushNotifications';
import { usePwaBootstrap } from './hooks/usePwaBootstrap';
import { usePwaColorScheme } from './hooks/usePwaColorScheme';
import { usePwaStatus } from './hooks/usePwaStatus';
import { useLaunchReminderModal } from './hooks/useLaunchReminderModal';
import { usePwaZoomLock } from './hooks/usePwaZoomLock';
import { useReminderSync } from './hooks/useReminderSync';
import { useReminderMutations } from './hooks/useReminderMutations';
import { useSheetTransition } from './hooks/useSheetTransition';
import { usePullToRefresh } from './hooks/usePullToRefresh';
import { useToast } from './hooks/useToast';
import {
	buildModalDraft,
	toSharedReminder,
} from './reminder-state';
import type {
	ModalMode,
	ModalState,
	StartTab,
	StoredConfig,
} from './types';

function App() {
	const { colorScheme, themePreference, setThemePreference } = usePwaColorScheme();
	const isDarkMode = colorScheme === 'dark';
	const [authToken, setAuthToken] = useState<string | null>(() => localStorage.getItem(AUTH_TOKEN_KEY));
	const [bootstrapped, setBootstrapped] = useState(false);
	const [config, setConfig] = useState<StoredConfig>(() => loadStoredConfig());
	const [selectedProject, setSelectedProject] = useState<string | null>(null);
	const [startTab, setStartTab] = useState<StartTab>('inbox');
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [launchReminderId, setLaunchReminderId] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [loggingOut, setLoggingOut] = useState(false);
	const [updateAvailable, setUpdateAvailable] = useState(false);
	const [modal, setModal] = useState<ModalState | null>(null);
	const [reorderDragging, setReorderDragging] = useState(false);
	const { toast, showToast } = useToast();
	const handleUnauthorizedRef = useRef<() => void>(() => undefined);
	const finalizeModalClose = useCallback(() => setModal(null), []);
	const finalizeSettingsClose = useCallback(() => setSettingsOpen(false), []);
	const modalTransition = useSheetTransition(finalizeModalClose);
	const settingsTransition = useSheetTransition(finalizeSettingsClose);

	usePwaZoomLock();

	useEffect(() => {
		void registerPwaServiceWorker().catch(() => undefined);
	}, []);

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
		resetReminderState,
		setReminders,
		setProjects,
		setLoading,
		setError,
	} = reminderSync;
	const initialContentReady = bootstrapped && (!authToken || !loading);
	const clearLocalSession = useCallback((showMessage: boolean) => {
		localStorage.removeItem(AUTH_TOKEN_KEY);
		localStorage.removeItem(REMINDERS_CACHE_KEY);
		setAuthToken(null);
		resetReminderState();
		settingsTransition.cancelClose();
		modalTransition.cancelClose();
		setSettingsOpen(false);
		setModal(null);
		if (showMessage) {
			setError(null);
			showToast('info', 'Logged out');
		}
	}, [modalTransition.cancelClose, resetReminderState, setError, settingsTransition.cancelClose, showToast]);

	useEffect(() => {
		handleUnauthorizedRef.current = () => clearLocalSession(false);
	}, [clearLocalSession]);

	const logOut = useCallback(async () => {
		if (loggingOut) return;
		setLoggingOut(true);
		try {
			await disablePushNotifications();
			const response = await apiFetch('/auth/session', { method: 'DELETE' });
			if (!response.ok) throw new Error(await response.text());
			clearLocalSession(true);
		} catch (logoutError) {
			showToast('error', logoutError instanceof Error ? logoutError.message : String(logoutError));
		} finally {
			setLoggingOut(false);
		}
	}, [apiFetch, clearLocalSession, disablePushNotifications, loggingOut, showToast]);

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

	const refreshInstallActivationUrl = useCallback(async () => {
		if (!authToken || isStandaloneApp()) return;
		const response = await apiFetch('/notifications/reminders-enrollment-token', { method: 'POST' });
		if (!response.ok) throw new Error(await response.text());
		const result = await response.json() as { token?: string };
		if (!result.token) throw new Error('Missing install token');
		replaceBrowserUrlWithInstallToken(result.token, config);
	}, [apiFetch, authToken, config]);

	useEffect(() => {
		if (!bootstrapped || !authToken) return;
		void refreshInstallActivationUrl().catch(() => undefined);
		void Promise.all([
			loadReminders({ silent: hydratedCacheRef.current }),
			refreshPushState().catch(() => undefined),
		]);
	}, [authToken, bootstrapped, loadReminders, refreshInstallActivationUrl, refreshPushState]);

	const checkForUpdate = useCallback(async () => {
		try {
			const assetVersion = await fetchPwaAssetVersion();
			if (assetVersion && assetVersion !== PWA_ASSET_VERSION) {
				setUpdateAvailable(true);
			}
		} catch {
			// Version checks are opportunistic and should not disrupt reminder use.
		}
	}, []);

	useEffect(() => {
		void checkForUpdate();
	}, [checkForUpdate]);

	useEffect(() => {
		const resume = () => {
			void checkForUpdate();
			if (!bootstrapped || !authToken) return;
			void loadReminders({ silent: true });
			void refreshPushState().catch(() => undefined);
		};
		const handleVisibilityChange = () => {
			if (document.visibilityState === 'visible') resume();
		};

		window.addEventListener('pageshow', resume);
		document.addEventListener('visibilitychange', handleVisibilityChange);
		return () => {
			window.removeEventListener('pageshow', resume);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	}, [authToken, bootstrapped, checkForUpdate, loadReminders, refreshPushState]);

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

	const pullRefresh = usePullToRefresh(
		Boolean(authToken && bootstrapped && !loading && !modal && !settingsOpen && !reorderDragging),
		useCallback(() => loadReminders({ silent: true }), [loadReminders]),
	);

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
			setModal({ mode, reminderId, draft: buildModalDraft(reminder, defaultProject ?? selectedProject) });
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
		closeModal,
		config,
		ensureCanMutate,
		loadReminders,
		projects,
		projectsRef,
		remindersRef,
		selectedProject,
		setProjects,
		setReminders,
		setSaving,
		showToast,
	});

	const sharedReminders = useMemo(() => reminders.map(toSharedReminder), [reminders]);
	const renderSharedCard = useCallback<ReminderCardRenderer>(({ reminder, index, hideProject }) => (
		<WebReminderCard
			key={`${reminder.id}-${reminder.dueDate || reminder.dueDatetime || ''}`}
			reminder={reminder}
			index={index}
			hideProject={hideProject}
			onEdit={(id) => openModal('edit', id)}
			onToggleComplete={(id, completed) => toggleReminderCompleted(id, completed)}
		/>
	), [openModal, toggleReminderCompleted]);

	if (bootstrapped && !authToken && initialContentReady) {
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
			<RemindersAppShell
				key={`pwa-shell-${selectedProject ?? startTab}`}
				reminders={sharedReminders}
				projects={projects}
				isInitialLoadComplete={initialContentReady}
				isDarkMode={isDarkMode}
				isFullScreen
				isModal
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
				reorderInteraction="long-press"
				belowHeaderContent={bootstrapped && authToken ? (
					<>
						<PwaPullRefreshIndicator pullRefresh={pullRefresh} />
						<PwaTopNotices
							statusText={statusText}
							statusKind={statusKind}
							updateAvailable={updateAvailable}
							showNotificationPrompt={canShowNotificationPrompt}
							onReload={() => window.location.reload()}
							onEnableNotifications={enablePushNotifications}
						/>
					</>
				) : undefined}
				loadingContent={!initialContentReady
					? <PwaLoadingSkeleton />
					: undefined}
				loadingTransition
				suppressFab={!bootstrapped || !authToken || !initialContentReady || Boolean(modal) || settingsOpen || readOnly}
				renderCard={renderSharedCard}
				onAdd={(defaultProject) => openModal('create', undefined, defaultProject)}
				onReorder={persistReorder}
				onReorderDragActiveChange={setReorderDragging}
			>
				{settingsOpen && (
					<SettingsSheet
						config={config}
						push={push}
						themePreference={themePreference}
						loggingOut={loggingOut}
						isClosing={settingsTransition.isClosing}
						onClose={settingsTransition.requestClose}
						onClosed={settingsTransition.finishClose}
						onEnablePush={enablePushNotifications}
						onThemePreferenceChange={setThemePreference}
						onLogout={() => void logOut()}
					/>
				)}
				{modal && (
					<ReminderSheet
						modal={modal}
						projects={projects}
						saving={saving}
						isClosing={modalTransition.isClosing}
						onChange={setModal}
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
			</RemindersAppShell>
		</div>
	);
}

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root');
createRoot(root).render(<App />);
