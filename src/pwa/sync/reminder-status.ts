import type { SyncIndicatorState } from '../../ui/shared/SyncIndicator';
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

export function reminderSyncStatus({ changes, isOffline, refreshing, loading, dataMode, error, storageError }: PwaSyncIndicatorProps): { state: SyncIndicatorState; label: string } {
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
	if (loading && !pendingCount) return { state: 'syncing', label: 'Loading reminders' };
	if (pendingCount || refreshing) return { state: 'syncing', label: pendingCount ? `Syncing ${pendingLabel}` : 'Refreshing reminders' };
	if (dataMode === 'cached') return { state: 'cached', label: 'Showing saved reminders: waiting to refresh' };
	return { state: 'synced', label: 'All changes synced' };
}
