import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RemindersAppShell, type ReminderCardRenderer } from '@/reminders/ui/RemindersAppShell';
import { buildStoredReminderDates } from '@/reminders/utils/reminderDate';
import { parseReminderContent } from '@/reminders/utils/reminderParser';
import { normalizeRecurrenceRule } from '@/reminders/utils/recurrenceRule';
import { PWA_ASSET_VERSION } from './pwa-version.gen';
import {
	AUTH_TOKEN_KEY,
	REMINDERS_CACHE_KEY,
	applyConfigFromUrl,
	detectDeviceName,
	formatLastUpdated,
	isStandaloneApp,
	loadCachedReminderSnapshot,
	loadStoredConfig,
	saveCachedReminderSnapshot,
} from './pwa-client/config';
import {
	exchangeEnrollmentToken,
	fetchPwaAssetVersion,
	makeApiFetch,
	registerPwaServiceWorker,
	replaceBrowserUrlWithInstallToken,
	urlBase64ToUint8Array,
	validateStoredAuthToken,
} from './pwa-client/api';
import { ErrorState, EmptyAuthState, LoadingAuthState } from './pwa-client/components/AuthStates';
import { PwaHeaderActions, PwaLoadingSkeleton, PwaPullRefreshIndicator, PwaTopNotices } from './pwa-client/components/PwaChrome';
import { ReminderSheet } from './pwa-client/components/ReminderSheet';
import { SettingsSheet } from './pwa-client/components/SettingsSheet';
import { WebReminderCard } from './pwa-client/components/WebReminderCard';
import { useKeyboardInset } from './pwa-client/hooks/useKeyboardInset';
import { usePullToRefresh } from './pwa-client/hooks/usePullToRefresh';
import {
	applyOptimisticReminderUpdate,
	buildModalDraft,
	buildOptimisticReminder,
	mergeProject,
	reorderProjectReminders,
	toSharedReminder,
} from './pwa-client/reminder-state';
import type {
	CachedReminderSnapshot,
	DataMode,
	ModalDraft,
	ModalMode,
	ModalState,
	PushState,
	ReminderMutationBody,
	ReminderRecord,
	StartTab,
	StoredConfig,
	ToastKind,
	ToastState,
} from './pwa-client/types';

function App() {
	const [authToken, setAuthToken] = useState<string | null>(() => localStorage.getItem(AUTH_TOKEN_KEY));
	const [bootstrapped, setBootstrapped] = useState(false);
	const [config, setConfig] = useState<StoredConfig>(() => loadStoredConfig());
	const [reminders, setReminders] = useState<ReminderRecord[]>([]);
	const [projects, setProjects] = useState<string[]>([]);
	const [selectedProject, setSelectedProject] = useState<string | null>(null);
	const [startTab, setStartTab] = useState<StartTab>('inbox');
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [launchReminderId, setLaunchReminderId] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dataMode, setDataMode] = useState<DataMode>('live');
	const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
	const [statusNow, setStatusNow] = useState(() => Date.now());
	const [isOffline, setIsOffline] = useState(() => typeof navigator !== 'undefined' ? !navigator.onLine : false);
	const [updateAvailable, setUpdateAvailable] = useState(false);
	const [modal, setModal] = useState<ModalState | null>(null);
	const [toast, setToastState] = useState<ToastState | null>(null);
	const [push, setPush] = useState<PushState>({ supported: false, subscribed: false, status: null });
	const toastTimerRef = useRef<number | null>(null);
	const remindersRef = useRef(reminders);
	const projectsRef = useRef(projects);
	const hydratedCacheRef = useRef(false);

	useKeyboardInset();

	useEffect(() => {
		void registerPwaServiceWorker().catch(() => undefined);
	}, []);

	useEffect(() => {
		remindersRef.current = reminders;
	}, [reminders]);

	useEffect(() => {
		projectsRef.current = projects;
	}, [projects]);

	useEffect(() => {
		const timer = window.setInterval(() => setStatusNow(Date.now()), 30_000);
		return () => window.clearInterval(timer);
	}, []);

	const showToast = useCallback((kind: ToastKind, message: string) => {
		setToastState({ kind, message });
		if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
		toastTimerRef.current = window.setTimeout(() => setToastState(null), 3200);
	}, []);

	const logOut = useCallback((showMessage: boolean) => {
		localStorage.removeItem(AUTH_TOKEN_KEY);
		localStorage.removeItem(REMINDERS_CACHE_KEY);
		setAuthToken(null);
		setReminders([]);
		setProjects([]);
		setSelectedProject(null);
		setSettingsOpen(false);
		setModal(null);
		if (showMessage) {
			setError(null);
			showToast('info', 'Logged out');
		}
	}, [showToast]);

	const apiFetch = useMemo(() => makeApiFetch(authToken, () => logOut(false)), [authToken, logOut]);

	const hydrateCachedSnapshot = useCallback((snapshot: CachedReminderSnapshot) => {
		setReminders(snapshot.reminders);
		setProjects(snapshot.projects);
		setLastUpdatedAt(snapshot.savedAt);
		setDataMode('cached');
		setSelectedProject((current) => current && !snapshot.projects.includes(current) ? null : current);
	}, []);

	const loadReminders = useCallback(async (options: { silent?: boolean } = {}) => {
		if (!authToken) return;
		if (options.silent) setRefreshing(true);
		else setLoading(true);
		setError(null);
		try {
			if (!navigator.onLine) {
				const cached = loadCachedReminderSnapshot(config.folderPath);
				if (cached) {
					hydrateCachedSnapshot(cached);
					return;
				}
				throw new Error('Offline');
			}

			const response = await apiFetch(`/reminders/list?folderPath=${encodeURIComponent(config.folderPath)}`);
			if (!response.ok) throw new Error(await response.text());
			const result = await response.json() as { reminders?: ReminderRecord[]; projects?: string[] };
			const nextReminders = Array.isArray(result.reminders) ? result.reminders : [];
			const nextProjects = Array.isArray(result.projects) ? result.projects : [];
			const savedAt = Date.now();
			setReminders(nextReminders);
			setProjects(nextProjects);
			setSelectedProject((current) => current && !nextProjects.includes(current) ? null : current);
			setLastUpdatedAt(savedAt);
			setDataMode('live');
			setIsOffline(false);
			saveCachedReminderSnapshot(config.folderPath, nextReminders, nextProjects, savedAt);
		} catch (loadError) {
			const message = loadError instanceof Error ? loadError.message : String(loadError);
			const cached = loadCachedReminderSnapshot(config.folderPath);
			if (cached) {
				hydrateCachedSnapshot(cached);
				setError(message);
			} else {
				setDataMode('error');
				setError(message);
			}
		} finally {
			setRefreshing(false);
			setLoading(false);
		}
	}, [apiFetch, authToken, config.folderPath, hydrateCachedSnapshot]);

	const refreshInstallActivationUrl = useCallback(async () => {
		if (!authToken || isStandaloneApp()) return;
		const response = await apiFetch('/notifications/reminders-enrollment-token', { method: 'POST' });
		if (!response.ok) throw new Error(await response.text());
		const result = await response.json() as { token?: string };
		if (!result.token) throw new Error('Missing install token');
		replaceBrowserUrlWithInstallToken(result.token, config);
	}, [apiFetch, authToken, config]);

	const refreshPushState = useCallback(async () => {
		const standalone = isStandaloneApp();
		const supported = 'serviceWorker' in navigator && 'PushManager' in window;
		if (!supported) {
			setPush({ supported: false, subscribed: false, status: 'Push notifications are not supported in this browser.' });
			return;
		}

		if (!standalone && /iPad|iPhone|iPod/.test(navigator.userAgent)) {
			setPush({ supported: true, subscribed: false, status: 'Install this app on your home screen to enable push notifications on iOS.' });
			return;
		}

		const registration = await registerPwaServiceWorker();
		if (!registration) {
			setPush({ supported: false, subscribed: false, status: 'Push notifications are not supported in this browser.' });
			return;
		}
		const subscription = await registration.pushManager.getSubscription();
		setPush({
			supported: true,
			subscribed: !!subscription,
			status: subscription ? 'Notifications enabled on this device.' : null,
		});
	}, []);

	useEffect(() => {
		let cancelled = false;

		async function bootstrap() {
			try {
				const applied = applyConfigFromUrl(loadStoredConfig());
				if (cancelled) return;
				setConfig(applied.config);
				if (applied.project) {
					setSelectedProject(applied.project);
				}
				if (applied.tab) {
					setStartTab(applied.tab);
				}
				if (applied.reminderId) {
					setLaunchReminderId(applied.reminderId);
				}

				let nextToken = authToken;
				if (nextToken && applied.token) {
					const storedTokenValid = await validateStoredAuthToken(nextToken);
					if (cancelled) return;
					if (!storedTokenValid) {
						localStorage.removeItem(AUTH_TOKEN_KEY);
						nextToken = null;
					}
				}

				if (!nextToken && applied.token) {
					nextToken = await exchangeEnrollmentToken(applied.token);
					localStorage.setItem(AUTH_TOKEN_KEY, nextToken);
					if (cancelled) return;
					setAuthToken(nextToken);
				}

				if (!nextToken) {
					setLoading(false);
					return;
				}

				const cached = loadCachedReminderSnapshot(applied.config.folderPath);
				hydratedCacheRef.current = Boolean(cached);
				if (cached) {
					hydrateCachedSnapshot(cached);
					setLoading(false);
				}
			} catch (bootstrapError) {
				if (!cancelled) {
					localStorage.removeItem(AUTH_TOKEN_KEY);
					setAuthToken(null);
					setError(bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError));
					setLoading(false);
				}
			} finally {
				if (!cancelled) {
					setBootstrapped(true);
				}
			}
		}

		void bootstrap();
		return () => {
			cancelled = true;
		};
	}, []);

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

	useEffect(() => {
		const handleOnline = () => {
			setIsOffline(false);
			if (bootstrapped && authToken) void loadReminders({ silent: true });
		};
		const handleOffline = () => setIsOffline(true);

		window.addEventListener('online', handleOnline);
		window.addEventListener('offline', handleOffline);
		return () => {
			window.removeEventListener('online', handleOnline);
			window.removeEventListener('offline', handleOffline);
		};
	}, [authToken, bootstrapped, loadReminders]);

	const readOnlyMessage = useMemo(() => {
		if (isOffline) return 'Offline data is read-only';
		if (dataMode === 'cached') return 'Showing last saved reminders. Refresh before editing.';
		if (dataMode === 'error') return 'Refresh reminders before editing.';
		return null;
	}, [dataMode, isOffline]);
	const readOnly = Boolean(readOnlyMessage);
	const canShowNotificationPrompt = Boolean(authToken && bootstrapped && push.supported && !push.subscribed && isStandaloneApp());
	const statusText = useMemo(() => {
		const lastUpdated = formatLastUpdated(lastUpdatedAt, statusNow);
		if (isOffline) return lastUpdatedAt ? `Offline - ${lastUpdated}` : 'Offline';
		if (dataMode === 'cached') return `${lastUpdated} - stale`;
		if (dataMode === 'error') return error ? `Refresh failed - ${error}` : 'Refresh failed';
		if (refreshing) return lastUpdatedAt ? `Refreshing - ${lastUpdated}` : 'Refreshing';
		return lastUpdatedAt ? lastUpdated : null;
	}, [dataMode, error, isOffline, lastUpdatedAt, refreshing, statusNow]);
	const statusKind = isOffline ? 'offline' : dataMode === 'live' ? 'live' : dataMode;

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

	const buildMutationBody = useCallback((draft: ModalDraft, mode: ModalMode): ReminderMutationBody => {
		const createDefaultProject = selectedProject ?? 'Inbox';
		const projectOptions = ['Inbox', ...projects.filter((project) => project !== 'Inbox')];
		const rawContent = draft.content.replace(/\s+/g, ' ').trim();
		const parsed = parseReminderContent(rawContent, projectOptions);
		const project = parsed.project || draft.project.trim() || createDefaultProject;
		const priority: 1 | 4 = parsed.priorityPart ? parsed.priority : draft.priority === 1 ? 1 : 4;
		const content = (parsed.cleanContent || rawContent).replace(/\s+/g, ' ').trim();
		const recurrence = normalizeRecurrenceRule(parsed.recurrence || draft.recurrence);
		let dueDate: string | null = null;
		let dueDatetime: string | null = null;

		if (parsed.dueDate) {
			const parsedDates = buildStoredReminderDates(parsed.dueDate, parsed.hasTime);
			dueDate = parsedDates.dueDate ?? null;
			dueDatetime = parsedDates.dueDatetime ?? null;
		} else if (!recurrence) {
			const rawDate = draft.dueDate.trim();
			const rawTime = draft.dueTime.trim();
			if (rawDate && rawTime) dueDatetime = new Date(`${rawDate}T${rawTime}`).toISOString();
			else if (rawDate) dueDate = rawDate;
		}

		return {
			folderPath: config.folderPath,
			allDayNotificationTime: config.allDayNotificationTime,
			content,
			description: draft.description.trim() || null,
			project,
			priority,
			dueDate,
			dueDatetime,
			recurrence: recurrence ?? (mode === 'edit' ? null : undefined),
		};
	}, [config.allDayNotificationTime, config.folderPath, projects, selectedProject]);

	const saveReminder = useCallback(async (currentModal: ModalState) => {
		if (!ensureCanMutate()) return;
		const body = buildMutationBody(currentModal.draft, currentModal.mode);
		if (!String(body.content || '').trim()) {
			showToast('error', 'Reminder title required');
			return;
		}

		setSaving(true);
		const previousReminders = remindersRef.current;
		const previousProjects = projectsRef.current;
		const isEdit = currentModal.mode === 'edit' && Boolean(currentModal.reminderId);
		const optimisticId = currentModal.reminderId ?? crypto.randomUUID();
		const optimisticReminder = buildOptimisticReminder(body, optimisticId);
		const nextProjects = mergeProject(previousProjects, optimisticReminder.project);
		setProjects(nextProjects);
		setReminders((current) => isEdit
			? current.map((reminder) => reminder.id === optimisticId ? applyOptimisticReminderUpdate(reminder, body) : reminder)
			: [...current, optimisticReminder]);
		closeModal();
		try {
			const path = isEdit ? '/reminders/update' : '/reminders/create';
			const requestBody: Record<string, unknown> = { ...body };
			requestBody.id = optimisticId;

			const response = await apiFetch(path, {
				method: 'POST',
				body: JSON.stringify(requestBody),
			});
			if (!response.ok) throw new Error(await response.text());
			const result = await response.json() as { notificationWarning?: string };
			await loadReminders({ silent: true });
			showToast(result.notificationWarning ? 'info' : 'success', result.notificationWarning
				? `Saved. Notification sync failed: ${result.notificationWarning}`
				: 'Reminder saved');
		} catch (saveError) {
			setReminders(previousReminders);
			setProjects(previousProjects);
			showToast('error', saveError instanceof Error ? saveError.message : String(saveError));
		}
	}, [apiFetch, buildMutationBody, closeModal, ensureCanMutate, loadReminders, showToast]);

	const toggleReminderCompleted = useCallback(async (reminderId: string, completed: boolean) => {
		if (!ensureCanMutate()) return;
		const previousReminders = remindersRef.current;
		const nextCompleted = !completed;
		setReminders((current) => current.map((reminder) => reminder.id === reminderId
			? { ...reminder, completed: nextCompleted, updatedAt: new Date().toISOString() }
			: reminder));
		try {
			const response = await apiFetch('/reminders/set-completed', {
				method: 'POST',
				body: JSON.stringify({
					folderPath: config.folderPath,
					allDayNotificationTime: config.allDayNotificationTime,
					id: reminderId,
					completed: nextCompleted,
				}),
			});
			if (!response.ok) throw new Error(await response.text());
			const result = await response.json() as { notificationWarning?: string };
			await loadReminders({ silent: true });
			if (result.notificationWarning) showToast('info', `Updated. Notification sync failed: ${result.notificationWarning}`);
		} catch (toggleError) {
			setReminders(previousReminders);
			showToast('error', toggleError instanceof Error ? toggleError.message : String(toggleError));
		}
	}, [apiFetch, config.allDayNotificationTime, config.folderPath, ensureCanMutate, loadReminders, showToast]);

	const deleteReminder = useCallback(async (reminderId: string) => {
		if (!ensureCanMutate()) return;
		const previousReminders = remindersRef.current;
		setReminders((current) => current.filter((reminder) => reminder.id !== reminderId));
		closeModal();
		try {
			const response = await apiFetch('/reminders/delete', {
				method: 'DELETE',
				body: JSON.stringify({ folderPath: config.folderPath, id: reminderId }),
			});
			if (!response.ok) throw new Error(await response.text());
			await loadReminders({ silent: true });
			showToast('success', 'Reminder deleted');
		} catch (deleteError) {
			setReminders(previousReminders);
			showToast('error', deleteError instanceof Error ? deleteError.message : String(deleteError));
		}
	}, [apiFetch, closeModal, config.folderPath, ensureCanMutate, loadReminders, showToast]);

	const persistReorder = useCallback(async (project: string, orderedIds: string[]) => {
		if (!ensureCanMutate()) {
			setReminders((current) => [...current]);
			return;
		}
		const previousReminders = remindersRef.current;
		setReminders((current) => reorderProjectReminders(current, project, orderedIds));
		try {
			const response = await apiFetch('/reminders/reorder', {
				method: 'POST',
				body: JSON.stringify({ folderPath: config.folderPath, project, orderedIds }),
			});
			if (!response.ok) throw new Error(await response.text());
			await loadReminders({ silent: true });
		} catch (reorderError) {
			setReminders(previousReminders);
			showToast('error', reorderError instanceof Error ? reorderError.message : String(reorderError));
		}
	}, [apiFetch, config.folderPath, ensureCanMutate, loadReminders, showToast]);

	const enablePushNotifications = useCallback(async () => {
		try {
			if (!push.supported) throw new Error('Push is not supported on this device.');
			const registration = await registerPwaServiceWorker();
			if (!registration) throw new Error('Push is not supported on this device.');
			const keyResponse = await fetch('/notifications/vapid-public-key');
			const { publicKey } = await keyResponse.json() as { publicKey?: string };
			if (!publicKey) throw new Error('Missing VAPID public key');
			const subscription = await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: urlBase64ToUint8Array(publicKey),
			});
			const body = subscription.toJSON();
			const response = await apiFetch('/notifications/subscribe', {
				method: 'POST',
				body: JSON.stringify({
					endpoint: body.endpoint,
					keys: body.keys,
					deviceName: detectDeviceName(),
				}),
			});
			if (!response.ok) throw new Error(await response.text());
			setPush({ supported: true, subscribed: true, status: 'Notifications enabled on this device.' });
			showToast('success', 'Notifications enabled');
		} catch (pushError) {
			const message = pushError instanceof Error ? pushError.message : String(pushError);
			setPush((current) => ({ ...current, status: message }));
			showToast('error', message);
		}
	}, [apiFetch, push.supported, showToast]);

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
