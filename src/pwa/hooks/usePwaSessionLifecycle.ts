import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { invalidatePwaSession } from '../session-generation';
import { clearReminderDrafts } from '../reminder-drafts';
import { clearReminderOutbox } from '../reminder-outbox-storage';
import { AUTH_TOKEN_KEY, PWA_LOGOUT_KEY, finishEnrollment, loadStoredConfig } from '../config';
import { clearCachedReminderSnapshots } from '../reminder-cache';
import type { ApiFetch, ModalState, ShowToast, StoredConfig } from '../types';

interface PwaLogoutOperations {
	apiFetch: ApiFetch;
	clearLocalSession: () => void | Promise<void>;
	disablePushNotifications: () => Promise<void>;
}

const SESSION_RECOVERY_MESSAGE = 'Session expired. Pending changes and drafts are kept on this device. Reconnect to their original reminders folder to recover them.';

export async function performPwaLogout({
	apiFetch,
	clearLocalSession,
	disablePushNotifications,
}: PwaLogoutOperations): Promise<boolean> {
	// Start remote cleanup while credentials are valid, then clear local state
	// immediately even if either network operation hangs or fails.
	const start = (operation: () => Promise<unknown>) => {
		try { return Promise.resolve(operation()); } catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
	};
	const cleanup = Promise.allSettled([
		start(disablePushNotifications),
		start(() => apiFetch('/auth/session', { method: 'DELETE' }).then(response => {
			if (!response.ok) throw new Error('Session revocation failed');
		})),
	]);
	await clearLocalSession();
	return (await cleanup).some(result => result.status === 'rejected');
}

export function usePwaSessionLifecycle({
	apiFetch,
	cancelModalClose,
	cancelSettingsClose,
	disablePushNotifications,
	handleUnauthorizedRef,
	resetReminderState,
	setAuthToken,
	setConfig,
	setError,
	setModal,
	setSettingsOpen,
	showToast,
}: {
	apiFetch: ApiFetch;
	cancelModalClose: () => void;
	cancelSettingsClose: () => void;
	disablePushNotifications: () => Promise<void>;
	handleUnauthorizedRef: MutableRefObject<() => void>;
	resetReminderState: () => void;
	setAuthToken: Dispatch<SetStateAction<string | null>>;
	setConfig: Dispatch<SetStateAction<StoredConfig>>;
	setError: Dispatch<SetStateAction<string | null>>;
	setModal: Dispatch<SetStateAction<ModalState | null>>;
	setSettingsOpen: Dispatch<SetStateAction<boolean>>;
	showToast: ShowToast;
}): {
	loggingOut: boolean;
	logOut: () => Promise<void>;
	clearLocalSession: () => Promise<void>;
	suspendLocalSession: () => Promise<void>;
} {
	const [loggingOut, setLoggingOut] = useState(false);
	const cleanupWarning = useRef<string | null>(null);
	const reportCleanupFailure = useCallback((message: string) => {
		cleanupWarning.current = message;
		showToast('error', message);
	}, [showToast]);

	const resetLocalSession = useCallback(async (nextToken: string | null, discardPrivateData = false) => {
		cleanupWarning.current = null;
		invalidatePwaSession();
		setAuthToken(nextToken);
		resetReminderState();
		cancelSettingsClose();
		cancelModalClose();
		setSettingsOpen(false);
		setModal(null);
		// Revoke in-memory authority before touching fallible browser storage.
		try { if (nextToken === null) localStorage.removeItem(AUTH_TOKEN_KEY); }
		catch { reportCleanupFailure('The saved sign-in could not be removed. Clear this site’s data in browser settings and revoke this browser session in Obsidian.'); }
		if (discardPrivateData && !clearReminderDrafts()) reportCleanupFailure('Drafts could not be cleared. Clear this site’s data in browser settings.');
		try { if (discardPrivateData) clearReminderOutbox(); }
		catch { reportCleanupFailure('Could not clear pending changes from this device. Clear this site’s data in browser settings.'); }
		if (!await clearCachedReminderSnapshots().catch(() => false)) {
			reportCleanupFailure('Offline data could not be cleared. Close other Crate tabs, then clear this site’s data in browser settings.');
		}
	}, [
		cancelModalClose,
		cancelSettingsClose,
		resetReminderState,
		setAuthToken,
		setModal,
		setSettingsOpen,
		reportCleanupFailure,
	]);
	const suspendLocalSession = useCallback(() => resetLocalSession(null), [resetLocalSession]);
	const clearLocalSession = useCallback(() => {
		// Other tabs must clear their sessionStorage drafts only for an explicit
		// logout. An auth-token removal alone may instead mean automatic expiry.
		const clearing = resetLocalSession(null, true);
		try { localStorage.setItem(PWA_LOGOUT_KEY, crypto.randomUUID()); }
		catch { reportCleanupFailure('Close other Crate tabs to clear their drafts. Browser storage could not be updated.'); }
		return clearing;
	}, [resetLocalSession, reportCleanupFailure]);

	useEffect(() => {
		handleUnauthorizedRef.current = () => {
			void suspendLocalSession();
			setError(SESSION_RECOVERY_MESSAGE);
		};
	}, [suspendLocalSession, handleUnauthorizedRef, setError]);

	useEffect(() => {
		let explicitLogout = false;
		const onStorage = (event: StorageEvent) => {
			try {
				if (event.key === PWA_LOGOUT_KEY) {
					if (event.newValue !== localStorage.getItem(PWA_LOGOUT_KEY)) return;
					// A suspended tab can receive logout after another tab has
					// already reconnected. Its old drafts must still be erased.
					clearReminderDrafts();
					if (localStorage.getItem(AUTH_TOKEN_KEY)) return;
					explicitLogout = true;
					invalidatePwaSession();
					setError(null);
					return;
				}
				if ((event.key === AUTH_TOKEN_KEY && event.newValue !== event.oldValue) || event.key === null) {
					if (event.key !== null && event.newValue !== localStorage.getItem(AUTH_TOKEN_KEY)) return;
					setConfig(loadStoredConfig());
					void resetLocalSession(event.newValue, event.key === null);
					setError(event.key !== null && event.newValue === null && !explicitLogout ? SESSION_RECOVERY_MESSAGE : null);
					explicitLogout = false;
				}
			} catch {
				void resetLocalSession(null, event.key === PWA_LOGOUT_KEY || event.key === null);
				setError('Browser storage is unavailable. Close other Crate tabs and clear this site’s data in browser settings.');
			}
		};
		window.addEventListener('storage', onStorage);
		return () => window.removeEventListener('storage', onStorage);
	}, [resetLocalSession, setConfig, setError]);

	const logOut = useCallback(async () => {
		if (loggingOut) return;
		try { finishEnrollment(false); } catch { /* Local logout must still complete. */ }
		setLoggingOut(true);
		try {
			const remoteCleanupFailed = await performPwaLogout({
				apiFetch,
				clearLocalSession,
				disablePushNotifications,
			});
			setError([cleanupWarning.current, remoteCleanupFailed ? 'Logged out locally. Remote cleanup could not finish. Remove this browser session from Crate’s connected devices in Obsidian.' : null].filter(Boolean).join(' ') || null);
			showToast(
				cleanupWarning.current ? 'error' : 'info',
				cleanupWarning.current ?? (remoteCleanupFailed
					? 'Logged out locally. Remote session cleanup could not finish.'
					: 'Logged out'),
			);
		} finally {
			setLoggingOut(false);
		}
	}, [apiFetch, clearLocalSession, disablePushNotifications, loggingOut, setError, showToast]);

	return { loggingOut, logOut, clearLocalSession, suspendLocalSession };
}
