import React from 'react';
import type { PendingReminderChange } from '../reminder-outbox-types';
import type { DataMode } from '../types';

interface PwaSyncIndicatorProps {
	changes: PendingReminderChange[];
	isOffline: boolean;
	refreshing: boolean;
	loading?: boolean;
	dataMode: DataMode;
	error: string | null;
	storageError: string | null;
}

function syncStatus({ changes, isOffline, refreshing, loading, dataMode, error, storageError }: PwaSyncIndicatorProps) {
	const pendingCount = changes.filter(change => change.status === 'pending').length;
	const errorCount = changes.length - pendingCount;
	const pendingLabel = `${pendingCount} ${pendingCount === 1 ? 'change' : 'changes'}`;
	if (storageError || errorCount || dataMode === 'error' || error) {
		return {
			state: 'error',
			label: storageError ? 'Sync needs attention: pending changes unavailable'
				: errorCount ? `${errorCount} ${errorCount === 1 ? 'change needs' : 'changes need'} attention`
					: 'Sync needs attention: refresh reminders',
		};
	}
	if (isOffline) return { state: 'offline', label: pendingCount ? `Offline: ${pendingLabel} waiting to sync` : 'Offline: showing saved reminders' };
	if (loading) return { state: 'syncing', label: 'Loading reminders' };
	if (pendingCount || refreshing) return { state: 'syncing', label: pendingCount ? `Syncing ${pendingLabel}` : 'Refreshing reminders' };
	if (dataMode === 'cached') return { state: 'cached', label: 'Showing saved reminders: waiting to refresh' };
	return { state: 'synced', label: 'All changes synced' };
}

/** Stable header space keeps background saves from moving the reminder list. */
export function PwaSyncIndicator(props: PwaSyncIndicatorProps) {
	const { state, label } = syncStatus(props);
	return (
		<div className="pwa-sync-indicator" data-sync-state={state} role="status" aria-live="polite" aria-atomic="true" title={label}>
			<span key={state} className="pwa-sync-indicator__dot" aria-hidden="true" />
			<span className="pwa-sync-indicator__label">{label}</span>
		</div>
	);
}
