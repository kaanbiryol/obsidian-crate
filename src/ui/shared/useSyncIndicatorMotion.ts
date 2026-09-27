import { useEffect, useRef, useState } from 'react';

const MIN_SYNC_MOTION_MS = 650;
// Match the outward success wave, which starts with the color transition.
const SETTLE_MOTION_MS = 1400;

/** Hold only the visual success transition; accessible status stays current. */
export function useSyncIndicatorMotion(state: string): string {
	const startedAt = useRef<number | null>(null);
	const [phase, setPhase] = useState<'idle' | 'syncing' | 'settling'>(state === 'syncing' ? 'syncing' : 'idle');

	useEffect(() => {
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.body.classList.contains('reduce-motion')) {
			startedAt.current = null;
			setPhase('idle');
			return;
		}
		if (state === 'syncing') {
			startedAt.current ??= performance.now();
			setPhase('syncing');
			return;
		}
		if (state !== 'synced' || startedAt.current === null) {
			startedAt.current = null;
			setPhase('idle');
			return;
		}

		let settleTimer: number | undefined;
		const finishTimer = window.setTimeout(() => {
			startedAt.current = null;
			setPhase('settling');
			settleTimer = window.setTimeout(() => setPhase('idle'), SETTLE_MOTION_MS);
		}, Math.max(0, MIN_SYNC_MOTION_MS - (performance.now() - startedAt.current)));
		return () => {
			window.clearTimeout(finishTimer);
			window.clearTimeout(settleTimer);
		};
	}, [state]);

	// A failure, disconnection, or new sync always interrupts success immediately.
	return state === 'synced' && phase !== 'idle' ? phase : state;
}
