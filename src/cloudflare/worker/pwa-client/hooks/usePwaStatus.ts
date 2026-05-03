import { useEffect, useMemo, useState } from 'react';
import { formatLastUpdated, isStandaloneApp } from '../config';
import type { DataMode, PushState } from '../types';

export function usePwaStatus({
	authToken,
	bootstrapped,
	dataMode,
	error,
	isOffline,
	lastUpdatedAt,
	push,
	refreshing,
}: {
	authToken: string | null;
	bootstrapped: boolean;
	dataMode: DataMode;
	error: string | null;
	isOffline: boolean;
	lastUpdatedAt: number | null;
	push: PushState;
	refreshing: boolean;
}): {
	readOnlyMessage: string | null;
	readOnly: boolean;
	canShowNotificationPrompt: boolean;
	statusText: string | null;
	statusKind: 'offline' | DataMode;
} {
	const [statusNow, setStatusNow] = useState(() => Date.now());

	useEffect(() => {
		const timer = window.setInterval(() => setStatusNow(Date.now()), 30_000);
		return () => window.clearInterval(timer);
	}, []);

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

	return {
		readOnlyMessage,
		readOnly,
		canShowNotificationPrompt,
		statusText,
		statusKind,
	};
}
