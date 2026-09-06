import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { invalidatePwaSession } from '../session-generation';
import { clearReminderDrafts } from '../reminder-drafts';
import { AUTH_TOKEN_KEY } from '../config';
import { clearCachedReminderSnapshots } from '../reminder-cache';
import type { ApiFetch, ModalState, ShowToast } from '../types';

interface PwaLogoutOperations {
	apiFetch: ApiFetch;
	clearLocalSession: () => void | Promise<void>;
	disablePushNotifications: () => Promise<void>;
}

export async function performPwaLogout({
	apiFetch,
	clearLocalSession,
	disablePushNotifications,
}: PwaLogoutOperations): Promise<boolean> {
	// Start remote cleanup while credentials are valid, then clear local state
	// immediately even if either network operation hangs or fails.
	const cleanup = Promise.allSettled([
		disablePushNotifications(),
		apiFetch('/auth/session', { method: 'DELETE' }).then(response => {
			if (!response.ok) throw new Error('Session revocation failed');
		}),
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
	setError: Dispatch<SetStateAction<string | null>>;
	setModal: Dispatch<SetStateAction<ModalState | null>>;
	setSettingsOpen: Dispatch<SetStateAction<boolean>>;
	showToast: ShowToast;
}): {
	loggingOut: boolean;
	logOut: () => Promise<void>;
} {
	const [loggingOut, setLoggingOut] = useState(false);

	const clearLocalSession = useCallback(async (nextToken: string | null = null) => {
		invalidatePwaSession();
		if (nextToken === null) localStorage.removeItem(AUTH_TOKEN_KEY);
		clearReminderDrafts();
		setAuthToken(nextToken);
		resetReminderState();
		cancelSettingsClose();
		cancelModalClose();
		setSettingsOpen(false);
		setModal(null);
		await clearCachedReminderSnapshots();
	}, [
		cancelModalClose,
		cancelSettingsClose,
		resetReminderState,
		setAuthToken,
		setModal,
		setSettingsOpen,
	]);

	useEffect(() => {
		handleUnauthorizedRef.current = () => {
			void clearLocalSession();
		};
	}, [clearLocalSession, handleUnauthorizedRef]);

	useEffect(() => {
		const onStorage = (event: StorageEvent) => {
			if ((event.key === AUTH_TOKEN_KEY && event.newValue !== event.oldValue) || event.key === null) {
				void clearLocalSession(event.newValue);
			}
		};
		window.addEventListener('storage', onStorage);
		return () => window.removeEventListener('storage', onStorage);
	}, [clearLocalSession]);

	const logOut = useCallback(async () => {
		if (loggingOut) return;
		setLoggingOut(true);
		try {
			const remoteCleanupFailed = await performPwaLogout({
				apiFetch,
				clearLocalSession,
				disablePushNotifications,
			});
			setError(remoteCleanupFailed ? 'Logged out locally. Remote cleanup could not finish. Remove this browser session from Crate’s connected devices in Obsidian.' : null);
			showToast(
				'info',
				remoteCleanupFailed
					? 'Logged out locally. Remote session cleanup could not finish.'
					: 'Logged out',
			);
		} finally {
			setLoggingOut(false);
		}
	}, [apiFetch, clearLocalSession, disablePushNotifications, loggingOut, setError, showToast]);

	return { loggingOut, logOut };
}
