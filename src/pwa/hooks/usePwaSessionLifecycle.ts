import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { AUTH_TOKEN_KEY, REMINDERS_CACHE_KEY } from '../config';
import type { ApiFetch, ModalState, ShowToast } from '../types';

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

	const clearLocalSession = useCallback((showMessage: boolean) => {
		localStorage.removeItem(AUTH_TOKEN_KEY);
		localStorage.removeItem(REMINDERS_CACHE_KEY);
		setAuthToken(null);
		resetReminderState();
		cancelSettingsClose();
		cancelModalClose();
		setSettingsOpen(false);
		setModal(null);
		if (showMessage) {
			setError(null);
			showToast('info', 'Logged out');
		}
	}, [
		cancelModalClose,
		cancelSettingsClose,
		resetReminderState,
		setAuthToken,
		setError,
		setModal,
		setSettingsOpen,
		showToast,
	]);

	useEffect(() => {
		handleUnauthorizedRef.current = () => clearLocalSession(false);
	}, [clearLocalSession, handleUnauthorizedRef]);

	const logOut = useCallback(async () => {
		if (loggingOut) return;
		setLoggingOut(true);
		try {
			await disablePushNotifications();
			const response = await apiFetch('/auth/session', { method: 'DELETE' });
			if (!response.ok) throw new Error(await response.text());
			clearLocalSession(true);
		} catch (error) {
			showToast('error', error instanceof Error ? error.message : String(error));
		} finally {
			setLoggingOut(false);
		}
	}, [apiFetch, clearLocalSession, disablePushNotifications, loggingOut, showToast]);

	return { loggingOut, logOut };
}
