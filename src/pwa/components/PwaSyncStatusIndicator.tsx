import { Button as BaseButton } from '@base-ui/react/button';
import React from 'react';
import { SyncIndicator, type SyncIndicatorState } from '../../ui/shared/SyncIndicator';

interface PwaSyncStatusIndicatorProps {
	state: SyncIndicatorState;
	label: string;
	onShowStatus: (label: string) => void;
}

/** Shared PWA touch target and announcement; each feature supplies its own status. */
export function PwaSyncStatusIndicator({ state, label, onShowStatus }: PwaSyncStatusIndicatorProps) {
	return <div className="pwa-sync-indicator" data-sync-state={state} title={label}>
		<BaseButton className="pwa-sync-indicator__button" type="button" aria-label={`Sync status: ${label}`} onClick={() => onShowStatus(label)}>
			<SyncIndicator state={state} />
		</BaseButton>
		<span className="pwa-sync-indicator__label" role="status" aria-live="polite" aria-atomic="true">{label}</span>
	</div>;
}
