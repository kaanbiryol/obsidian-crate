import { useLayoutEffect, useRef } from 'react';
import { PWA_FADE_TIMING } from './navigation/motion';
import { useReducedMotion } from './useReducedMotion';

/**
 * Fades `regions` in when content replaces a loading state, including the
 * first content shown. Content already on screen never fades again, so
 * background refreshes and returns to loaded screens stay still.
 */
export function useContentReveal(loading: boolean, regions: () => Iterable<HTMLElement> | undefined): void {
	const reduceMotion = useReducedMotion();
	const shown = useRef(false);
	const read = useRef(regions);
	read.current = regions;

	useLayoutEffect(() => {
		if (loading) { shown.current = false; return; }
		if (shown.current) return;
		shown.current = true;
		if (reduceMotion) return;
		const animations = Array.from(read.current() ?? [], region => region.animate(
			[{ opacity: 0 }, { opacity: 1 }],
			PWA_FADE_TIMING,
		));
		return () => animations.forEach(animation => animation.cancel());
	}, [loading, reduceMotion]);
}
