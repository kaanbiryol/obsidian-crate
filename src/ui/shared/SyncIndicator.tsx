import React from 'react';
import { useSyncIndicatorMotion } from './useSyncIndicatorMotion';

export type SyncIndicatorState = 'syncing' | 'synced' | 'error' | 'offline' | 'pending' | 'cached';

/** Shared visual indicator; each host supplies its status label and interaction. */
export function SyncIndicator({ state }: { state: SyncIndicatorState }) {
	const visualState = useSyncIndicatorMotion(state);
	return <span className="crate-sync-indicator" data-sync-state={state} data-visual-state={visualState} aria-hidden="true">
		<span className="crate-sync-indicator__halo" />
		<span className="crate-sync-indicator__dot" />
		<span className="crate-sync-indicator__ripple" />
	</span>;
}
