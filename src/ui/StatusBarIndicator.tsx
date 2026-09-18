import React from 'react';
import type { SyncState } from '../sync/types';
import { SyncIndicator } from './shared/SyncIndicator';

export function StatusBarIndicator({ state }: { state: SyncState }) {
	const status = state.status === 'error' || state.conflictCount > 0 ? 'error'
		: state.status === 'offline' ? 'offline'
			: state.status === 'syncing' ? 'syncing'
				: state.pendingChanges > 0 ? 'pending'
					: state.lastSync ? 'synced' : 'cached';
	return <SyncIndicator state={status} />;
}
