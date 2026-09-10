import { useCallback, useEffect, useRef, useState } from 'react';
import { applyPwaUpdate } from '../apply-update';
import { finishPwaUpdateTransition, preparePwaUpdateTransition } from '../update-transition';
import { whenUpdateLayoutSettles } from '../update-layout-readiness';
import type { ShowToast } from '../types';

export function usePwaUpdate(showToast: ShowToast, contentReady: boolean) {
	const [updating, setUpdating] = useState(false);
	const inFlight = useRef(false);
	useEffect(() => {
		if (document.documentElement.dataset.pwaUpdating !== 'restore') return;
		document.getElementById('app')?.setAttribute('inert', '');
		if (!contentReady) return;
		// Data readiness can precede safe-area, viewport and notice layout updates.
		return whenUpdateLayoutSettles(finishPwaUpdateTransition);
	}, [contentReady]);

	const update = useCallback(() => {
		if (inFlight.current) return;
		inFlight.current = true;
		setUpdating(true);
		void applyPwaUpdate(preparePwaUpdateTransition).catch((error: unknown) => {
			finishPwaUpdateTransition();
			showToast('error', error instanceof Error ? error.message : 'Update failed. Please try again.');
			inFlight.current = false;
			setUpdating(false);
		});
	}, [showToast]);
	return { updating, update };
}
