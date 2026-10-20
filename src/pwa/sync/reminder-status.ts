import type { SyncIndicatorState } from '../../ui/shared/SyncIndicator';
import type { PendingReminderChange } from '../reminders/outbox/reminder-outbox-types';
import type { DataMode } from '../types';
import type { ReminderIndexingProgress } from '../reminders/reminder-api';

interface PwaSyncIndicatorProps {
	changes: PendingReminderChange[];
	isOffline: boolean;
	refreshing: boolean;
	loading?: boolean;
	indexingProgress: ReminderIndexingProgress | null;
	dataMode: DataMode;
	error: string | null;
	storageError: string | null;
}

export function reminderSyncStatus({ changes, isOffline, refreshing, loading, indexingProgress, dataMode, error, storageError }: PwaSyncIndicatorProps): { state: SyncIndicatorState; label: string } {
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
	if (indexingProgress) return { state: 'syncing', label: `Preparing reminders: ${indexingProgress.indexedFiles} of ${indexingProgress.totalFiles} files indexed…` };
	if (loading && !pendingCount) return { state: 'syncing', label: 'Loading reminders' };
	if (pendingCount || refreshing) return { state: 'syncing', label: pendingCount ? `Syncing ${pendingLabel}` : 'Refreshing reminders' };
	// Hydration can finish before the startup refresh begins. Online startup is
	// still checking the server, even while the saved snapshot is already visible.
	if (dataMode === 'cached') return { state: 'syncing', label: 'Checking reminders' };
	return { state: 'synced', label: 'All changes synced' };
}
