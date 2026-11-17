import { useEffect, useMemo, useState } from 'react';
import { isStandaloneApp } from '../shell/device';
import type { DataMode } from '../types';
import type { PushState } from './types';
import { connectionIssueReason } from '../components/PwaConnectionBanner';

function formatLastUpdated(timestamp: number, now: number): string {
	const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (elapsedSeconds < 45) return 'updated just now';
	if (elapsedSeconds < 90) return 'updated 1m ago';
	const elapsedMinutes = Math.floor(elapsedSeconds / 60);
	if (elapsedMinutes < 60) return `updated ${elapsedMinutes}m ago`;
	const elapsedHours = Math.floor(elapsedMinutes / 60);
	if (elapsedHours < 24) return `updated ${elapsedHours}h ago`;
	const elapsedDays = Math.floor(elapsedHours / 24);
	return `updated ${elapsedDays}d ago`;
}

/** The connection banner: offline, or the last refresh or encryption check failed. */
export function getPwaStatusText({
	dataMode,
	error,
	isOffline,
	lastUpdatedAt,
	now,
	unavailableMessage = null,
}: {
	dataMode: DataMode;
	error: string | null;
	isOffline: boolean;
	lastUpdatedAt: number | null;
	now: number;
	unavailableMessage?: string | null;
}): string | null {
	const updated = lastUpdatedAt ? ` · ${formatLastUpdated(lastUpdatedAt, now)}` : '';
	if (isOffline) return `Offline${updated}`;
	const reason = connectionIssueReason(unavailableMessage);
	if (reason) return reason;
	// Cached data is hydrated before the initial live refresh starts. Keep that
	// normal startup handoff quiet unless the refresh actually fails.
	if (unavailableMessage || dataMode === 'error' || (dataMode === 'cached' && error)) return `Couldn’t connect${updated}`;
	return null;
}

export function usePwaStatus({
	authToken,
	bootstrapped,
	dataMode,
	error,
	isOffline,
	lastUpdatedAt,
	push,
	unavailableMessage = null,
}: {
	authToken: string | null;
	bootstrapped: boolean;
	dataMode: DataMode;
	error: string | null;
	isOffline: boolean;
	lastUpdatedAt: number | null;
	push: PushState;
	/** An unanswered encryption check while the offline copy is shown. */
	unavailableMessage?: string | null;
}): {
	readOnlyMessage: string | null;
	readOnly: boolean;
	canShowNotificationPrompt: boolean;
	statusText: string | null;
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
		if (unavailableMessage || dataMode === 'cached') return 'Showing last saved reminders. Refresh before editing.';
		if (dataMode === 'error') return 'Refresh reminders before editing.';
		return null;
	}, [dataMode, isOffline, unavailableMessage]);
	const readOnly = Boolean(readOnlyMessage);
	const statusText = useMemo(() => getPwaStatusText({
		dataMode,
		error,
		isOffline,
		lastUpdatedAt,
		now: statusNow,
		unavailableMessage,
	}), [dataMode, error, isOffline, lastUpdatedAt, statusNow, unavailableMessage]);
	// Enabling alerts needs the server, so the prompt waits while the banner shows.
	const canShowNotificationPrompt = Boolean(authToken && bootstrapped && !statusText && (push.phase === 'off' || push.phase === 'error') && isStandaloneApp());

	return {
		readOnlyMessage,
		readOnly,
		canShowNotificationPrompt,
		statusText,
	};
}
