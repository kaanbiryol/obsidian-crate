import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RemindersAppShell, type ReminderCardRenderer } from '@/reminders/ui/RemindersAppShell';
import { PWA_ASSET_VERSION } from './pwa-version.gen';
import {
	AUTH_TOKEN_KEY,
	REMINDERS_CACHE_KEY,
	isStandaloneApp,
	loadStoredConfig,
} from './pwa-client/config';
import {
	fetchPwaAssetVersion,
	makeApiFetch,
	registerPwaServiceWorker,
	replaceBrowserUrlWithInstallToken,
} from './pwa-client/api';
import { ErrorState, EmptyAuthState, LoadingAuthState } from './pwa-client/components/AuthStates';
import { PwaHeaderActions, PwaLoadingSkeleton, PwaPullRefreshIndicator, PwaTopNotices } from './pwa-client/components/PwaChrome';
import { ReminderSheet } from './pwa-client/components/ReminderSheet';
import { SettingsSheet } from './pwa-client/components/SettingsSheet';
import { WebReminderCard } from './pwa-client/components/WebReminderCard';
import { useKeyboardInset } from './pwa-client/hooks/useKeyboardInset';
import { usePushNotifications } from './pwa-client/hooks/usePushNotifications';
import { usePwaBootstrap } from './pwa-client/hooks/usePwaBootstrap';
import { usePwaStatus } from './pwa-client/hooks/usePwaStatus';
import { useReminderSync } from './pwa-client/hooks/useReminderSync';
import { useReminderMutations } from './pwa-client/hooks/useReminderMutations';
import { usePullToRefresh } from './pwa-client/hooks/usePullToRefresh';
import { useToast } from './pwa-client/hooks/useToast';
import {
	buildModalDraft,
	toSharedReminder,
} from './pwa-client/reminder-state';
import type {
	ModalMode,
	ModalState,
	StartTab,
	StoredConfig,
} from './pwa-client/types';

function App() {
	const [authToken, setAuthToken] = useState<string | null>(() => localStorage.getItem(AUTH_TOKEN_KEY));
	const [bootstrapped, setBootstrapped] = useState(false);
	const [config, setConfig] = useState<StoredConfig>(() => loadStoredConfig());
	const [selectedProject, setSelectedProject] = useState<string | null>(null);
	const [startTab, setStartTab] = useState<StartTab>('inbox');
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [launchReminderId, setLaunchReminderId] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [updateAvailable, setUpdateAvailable] = useState(false);
	const [modal, setModal] = useState<ModalState | null>(null);
	const { toast, showToast } = useToast();
	const handleUnauthorizedRef = useRef<() => void>(() => undefined);

	useKeyboardInset();

	useEffect(() => {
		void registerPwaServiceWorker().catch(() => undefined);
	}, []);

	const apiFetch = useMemo(
		() => makeApiFetch(authToken, () => handleUnauthorizedRef.current()),
		[authToken],
	);
	const reminderSync = useReminderSync({ apiFetch, authToken, bootstrapped, config, setSelectedProject });
	const { push, refreshPushState, enablePushNotifications } = usePushNotifications({ apiFetch, showToast });
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
		resetReminderState,
		setReminders,
		setProjects,
		setLoading,
		setError,
	} = reminderSync;

	const logOut = useCallback((showMessage: boolean) => {
		localStorage.removeItem(AUTH_TOKEN_KEY);
		localStorage.removeItem(REMINDERS_CACHE_KEY);
		setAuthToken(null);
		resetReminderState();
		setSettingsOpen(false);
		setModal(null);
		if (showMessage) {
			setError(null);
			showToast('info', 'Logged out');
		}
	}, [resetReminderState, setError, showToast]);

	useEffect(() => {
		handleUnauthorizedRef.current = () => logOut(false);
	}, [logOut]);

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
		Boolean(authToken && bootstrapped && !loading && !modal && !settingsOpen),
		useCallback(() => loadReminders({ silent: true }), [loadReminders]),
	);

	useEffect(() => {
		if (!launchReminderId || !bootstrapped || !authToken || loading) return;
		if (!isOffline && dataMode === 'cached' && refreshing) return;

		const reminder = reminders.find((item) => item.id === launchReminderId);
		if (!reminder) {
			if (!refreshing) {
				showToast('info', 'Reminder no longer exists');
				setLaunchReminderId(null);
			}
			return;
		}

		setSelectedProject(reminder.project || null);
		if (readOnlyMessage) {
			showToast('info', readOnlyMessage);
			setLaunchReminderId(null);
			return;
		}

		setSettingsOpen(false);
		setSaving(false);
		setModal({
			mode: 'edit',
			reminderId: reminder.id,
			draft: buildModalDraft(reminder, reminder.project || selectedProject),
		});
		setLaunchReminderId(null);
	}, [
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
		showToast,
	]);

	const openModal = useCallback((mode: ModalMode, reminderId?: string, defaultProject?: string) => {
		if (!ensureCanMutate()) return;
		const reminder = reminderId ? reminders.find((item) => item.id === reminderId) ?? null : null;
		setSettingsOpen(false);
		setSaving(false);
		setModal({ mode, reminderId, draft: buildModalDraft(reminder, defaultProject ?? selectedProject) });
	}, [ensureCanMutate, reminders, selectedProject]);

	const closeModal = useCallback(() => {
		setModal(null);
		setSaving(false);
	}, []);

	const {
		saveReminder,
		toggleReminderCompleted,
		deleteReminder,
		persistReorder,
	} = useReminderMutations({
		apiFetch,
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

	if (!bootstrapped) {
		return <LoadingAuthState />;
	}

	if (!authToken) {
		return error
			? <ErrorState error={error} config={config} onRetry={() => window.location.reload()} />
			: <EmptyAuthState config={config} />;
	}

	return (
		<div className="reminders-shadow-root pwa-shadow-root">
			<RemindersAppShell
				key={`pwa-shell-${selectedProject ?? startTab}`}
				reminders={sharedReminders}
				projects={projects}
				isInitialLoadComplete={!loading}
				isDarkMode
				isFullScreen
				isModal
				initialTab={selectedProject ? 'browse' : startTab}
				initialProject={selectedProject ?? undefined}
				upcomingDays={config.upcomingDays}
				className="app-shell pwa-reminders-view"
				headerRightContent={
					<PwaHeaderActions
						settingsOpen={settingsOpen}
						statusText={statusText}
						statusKind={statusKind}
						refreshing={refreshing}
						onRefresh={() => void loadReminders({ silent: true })}
						onToggleSettings={() => setSettingsOpen((open) => !open)}
					/>
				}
				belowHeaderContent={
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
				}
				loadingContent={loading ? <PwaLoadingSkeleton /> : undefined}
				suppressFab={Boolean(modal) || settingsOpen || readOnly}
				renderCard={renderSharedCard}
				onAdd={(defaultProject) => openModal('create', undefined, defaultProject)}
				onReorder={persistReorder}
			>
				{settingsOpen && (
					<SettingsSheet
						config={config}
						push={push}
						onClose={() => setSettingsOpen(false)}
						onEnablePush={enablePushNotifications}
						onRefresh={() => void loadReminders()}
						onLogout={() => logOut(true)}
					/>
				)}
				{modal && (
					<ReminderSheet
						modal={modal}
						projects={projects}
						saving={saving}
						onChange={setModal}
						onClose={closeModal}
						onSave={saveReminder}
						onDelete={deleteReminder}
					/>
				)}
				{toast && <div className={`toast is-${toast.kind}`}>{toast.message}</div>}
			</RemindersAppShell>
		</div>
	);
}

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app root');
createRoot(root).render(<App />);
