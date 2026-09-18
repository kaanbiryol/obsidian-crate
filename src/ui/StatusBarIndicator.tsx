import React from 'react';
import type { SyncState } from '../sync/types';
import { useSyncIndicatorMotion } from './shared/useSyncIndicatorMotion';

export function StatusBarIndicator({ state }: { state: SyncState }) {
	const status = state.status === 'error' || state.conflictCount > 0 ? 'error'
		: state.status === 'offline' ? 'offline'
			: state.status === 'syncing' ? 'syncing'
				: state.pendingChanges > 0 ? 'pending'
					: state.lastSync ? 'synced' : 'cached';
	const visualState = useSyncIndicatorMotion(status);
	return <span className="crate-sync-indicator" data-sync-state={status} data-visual-state={visualState} aria-hidden="true">
		<span className="crate-sync-indicator__halo" />
		<span className="crate-sync-indicator__dot" />
		<span className="crate-sync-indicator__ripple" />
	</span>;
}
