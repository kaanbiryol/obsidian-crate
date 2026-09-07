import { useCallback, useEffect, useRef, useState } from 'react';
import { applyPwaUpdate } from '../apply-update';
import { finishPwaUpdateTransition, preparePwaUpdateTransition } from '../update-transition';
import type { ShowToast } from '../types';

export function usePwaUpdate(showToast: ShowToast, contentReady: boolean) {
	const [updating, setUpdating] = useState(false);
	const inFlight = useRef(false);
	useEffect(() => {
		if (document.documentElement.dataset.pwaUpdating !== 'restore') return;
		document.getElementById('app')?.setAttribute('inert', '');
		if (!contentReady) return;
		// Reveal the hydrated app, including pending local changes, together.
		// Two frames also let the new document paint its matching curtain first.
		let frame = requestAnimationFrame(() => {
			frame = requestAnimationFrame(finishPwaUpdateTransition);
		});
		return () => cancelAnimationFrame(frame);
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
