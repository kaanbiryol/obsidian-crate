import { useEffect, useRef, useState } from 'react';

const MIN_SYNC_MOTION_MS = 650;
const SETTLE_MOTION_MS = 800;

/** Hold only the visual success transition; accessible status stays current. */
export function useSyncIndicatorMotion(state: string): string {
	const startedAt = useRef<number | null>(null);
	const [phase, setPhase] = useState<'idle' | 'syncing' | 'settling'>(state === 'syncing' ? 'syncing' : 'idle');

	useEffect(() => {
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
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

		let settleTimer: ReturnType<typeof setTimeout> | undefined;
		const finishTimer = setTimeout(() => {
			startedAt.current = null;
			setPhase('settling');
			settleTimer = setTimeout(() => setPhase('idle'), SETTLE_MOTION_MS);
		}, Math.max(0, MIN_SYNC_MOTION_MS - (performance.now() - startedAt.current)));
		return () => {
			clearTimeout(finishTimer);
			clearTimeout(settleTimer);
		};
	}, [state]);

	// A failure, disconnection, or new sync always interrupts success immediately.
	return state === 'synced' && phase !== 'idle' ? phase : state;
}
