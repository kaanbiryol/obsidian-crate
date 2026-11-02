import { useEffect, useMemo, useState } from 'react';
import { isStandaloneApp } from '../shell/device';
import type { DataMode } from '../types';
import type { PushState } from './types';

function formatLastUpdated(timestamp: number | null, now: number): string {
	if (!timestamp) return 'Not updated yet';
	const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (elapsedSeconds < 45) return 'Last updated just now';
	if (elapsedSeconds < 90) return 'Last updated 1m ago';
	const elapsedMinutes = Math.floor(elapsedSeconds / 60);
	if (elapsedMinutes < 60) return `Last updated ${elapsedMinutes}m ago`;
	const elapsedHours = Math.floor(elapsedMinutes / 60);
	if (elapsedHours < 24) return `Last updated ${elapsedHours}h ago`;
	const elapsedDays = Math.floor(elapsedHours / 24);
	return `Last updated ${elapsedDays}d ago`;
}

export function getPwaStatusText({
	dataMode,
	error,
	isOffline,
	lastUpdatedAt,
	now,
	refreshing,
}: {
	dataMode: DataMode;
	error: string | null;
	isOffline: boolean;
	lastUpdatedAt: number | null;
	now: number;
	refreshing: boolean;
}): string | null {
	const lastUpdated = formatLastUpdated(lastUpdatedAt, now);
	if (isOffline) return lastUpdatedAt ? `Offline - ${lastUpdated}` : 'Offline';
	// Cached data is hydrated before the initial live refresh starts. Keep that
	// normal startup handoff quiet unless the refresh actually fails.
	if (dataMode === 'cached') return error ? `${lastUpdated} - stale` : null;
	if (dataMode === 'error') return error ? `Refresh failed - ${error}` : 'Refresh failed';
	if (refreshing) return lastUpdatedAt ? `Refreshing - ${lastUpdated}` : 'Refreshing';
	return lastUpdatedAt ? lastUpdated : null;
}

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
		// The relative "updated" label only needs refreshing while it can be seen.
		let timer: number | undefined;
		const start = () => { timer = window.setInterval(() => setStatusNow(Date.now()), 30_000); };
		const onVisibilityChange = () => {
			window.clearInterval(timer);
			timer = undefined;
			if (document.visibilityState === 'hidden') return;
			setStatusNow(Date.now());
			start();
		};
		if (document.visibilityState !== 'hidden') start();
		document.addEventListener('visibilitychange', onVisibilityChange);
		return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisibilityChange); };
	}, []);

	const readOnlyMessage = useMemo(() => {
		if (isOffline) return 'Offline data is read-only';
		if (dataMode === 'cached') return 'Showing last saved reminders. Refresh before editing.';
		if (dataMode === 'error') return 'Refresh reminders before editing.';
		return null;
	}, [dataMode, isOffline]);
	const readOnly = Boolean(readOnlyMessage);
	const canShowNotificationPrompt = Boolean(authToken && bootstrapped && (push.phase === 'off' || push.phase === 'error') && isStandaloneApp());
	const statusText = useMemo(() => getPwaStatusText({
		dataMode,
		error,
		isOffline,
		lastUpdatedAt,
		now: statusNow,
		refreshing,
	}), [dataMode, error, isOffline, lastUpdatedAt, refreshing, statusNow]);
	const statusKind = isOffline ? 'offline' : dataMode === 'live' ? 'live' : dataMode;

	return {
		readOnlyMessage,
		readOnly,
		canShowNotificationPrompt,
		statusText,
		statusKind,
	};
}
