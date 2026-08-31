import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
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
	let remoteCleanupFailed = false;

	try {
		await disablePushNotifications();
	} catch {
		remoteCleanupFailed = true;
	}

	try {
		const response = await apiFetch('/auth/session', { method: 'DELETE' });
		if (!response.ok) remoteCleanupFailed = true;
	} catch {
		remoteCleanupFailed = true;
	} finally {
		await clearLocalSession();
	}

	return remoteCleanupFailed;
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

	const clearLocalSession = useCallback(async () => {
		localStorage.removeItem(AUTH_TOKEN_KEY);
		setAuthToken(null);
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

	const logOut = useCallback(async () => {
		if (loggingOut) return;
		setLoggingOut(true);
		try {
			const remoteCleanupFailed = await performPwaLogout({
				apiFetch,
				clearLocalSession,
				disablePushNotifications,
			});
			setError(null);
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
