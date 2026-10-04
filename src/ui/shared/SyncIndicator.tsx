import React from 'react';
import { useSyncIndicatorMotion } from './useSyncIndicatorMotion';

export type SyncIndicatorState = 'syncing' | 'synced' | 'error' | 'offline' | 'pending' | 'cached';

/** Shared visual indicator; each host supplies its status label and interaction. */
export function SyncIndicator({ state }: { state: SyncIndicatorState }) {
	const visualState = useSyncIndicatorMotion(state);
	return <svg className="crate-sync-indicator" viewBox="0 0 16 16" data-sync-state={state} data-visual-state={visualState} aria-hidden="true" focusable="false">
		<circle className="crate-sync-indicator__halo" cx="8" cy="8" r="8" />
		<circle className="crate-sync-indicator__glow" cx="8" cy="8" r="7" />
		<circle className="crate-sync-indicator__dot" cx="8" cy="8" r="4" />
		<circle className="crate-sync-indicator__ripple" cx="8" cy="8" r="5.5" />
	</svg>;
}
