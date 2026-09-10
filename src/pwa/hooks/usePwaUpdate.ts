import { useCallback, useEffect, useRef, useState } from 'react';
import { startAutoPwaUpdate } from '../auto-update';
import { applyPwaUpdate } from '../apply-update';
import { finishPwaUpdateTransition, preparePwaUpdateTransition } from '../update-transition';
import { whenUpdateLayoutSettles } from '../update-layout-readiness';
import type { ShowToast } from '../types';

export function usePwaUpdate(showToast: ShowToast, contentReady: boolean, auto: {
	version: string | null;
	canApply: () => boolean;
}) {
	const canAutoApply = useRef(auto.canApply);
	canAutoApply.current = auto.canApply;
	const [updating, setUpdating] = useState(false);
	const inFlight = useRef(false);
	useEffect(() => {
		if (document.documentElement.dataset.pwaUpdating !== 'restore') return;
		document.getElementById('app')?.setAttribute('inert', '');
		if (!contentReady) return;
		// Data readiness can precede safe-area, viewport and notice layout updates.
		return whenUpdateLayoutSettles(finishPwaUpdateTransition);
	}, [contentReady]);

	const apply = useCallback(async (options: Parameters<typeof applyPwaUpdate>[1] = {}) => {
		if (inFlight.current) return false;
		inFlight.current = true;
		setUpdating(true);
		let reloading = false;
		try {
			reloading = await applyPwaUpdate(preparePwaUpdateTransition, options);
			return reloading;
		} finally {
			if (!reloading) {
				finishPwaUpdateTransition();
				inFlight.current = false;
				setUpdating(false);
			}
		}
	}, []);

	const update = useCallback(() => {
		void apply().catch((error: unknown) => {
			showToast('error', error instanceof Error ? error.message : 'Update failed. Please try again.');
		});
	}, [apply, showToast]);

	useEffect(() => {
		if (!auto.version) return;
		return startAutoPwaUpdate(auto.version, () => canAutoApply.current(),
			(version, canApply, beforeNavigation) => apply({ version, canApply, beforeNavigation }));
	}, [auto.version, apply]);

	return { updating, update };
}
