import type { SyncIndicatorState } from '@/ui/shared/SyncIndicator';
import type { PendingReading } from '../reading/outbox';

interface ReadingSyncIndicatorProps {
	pending: PendingReading[];
	isOffline: boolean;
	loading: boolean;
	refreshing: boolean;
	confirmed: boolean;
	error: string | null;
	recovery: boolean;
}

export function readingSyncStatus({ pending, isOffline, loading, refreshing, confirmed, error, recovery }: ReadingSyncIndicatorProps): { state: SyncIndicatorState; label: string } {
	const attention = pending.filter(op => op.review || op.error).length;
	if (recovery) return { state: 'error', label: 'Sync needs attention: earlier changes are stored on this device' };
	if (attention) return { state: 'error', label: `${attention} ${attention === 1 ? 'change needs' : 'changes need'} attention` };
	if (error) return { state: 'error', label: 'Sync needs attention: refresh Reading' };
	const changes = `${pending.length} ${pending.length === 1 ? 'change' : 'changes'}`;
	if (isOffline) return { state: 'offline', label: pending.length ? `Offline: ${changes} waiting to sync` : 'Offline: showing saved Reading data' };
	if (loading && !pending.length) return { state: 'syncing', label: 'Loading Reading' };
	if (pending.length || refreshing) return { state: 'syncing', label: pending.length ? `Syncing ${changes}` : 'Refreshing Reading' };
	// Include connection verification before the list request starts, so cached
	// startup stays yellow until this session has a confirmed server result.
	if (!confirmed) return { state: 'syncing', label: 'Checking Reading' };
	return { state: 'synced', label: 'All changes synced' };
}
