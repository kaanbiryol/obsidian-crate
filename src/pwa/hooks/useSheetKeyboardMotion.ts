import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

/** Resize once, then animate the surface's displacement without laying out its fields every frame. */
export function useSheetKeyboardMotion(
	stageRef: RefObject<HTMLDivElement | null>,
	keyboardInset: number,
	reducedMotion: boolean | null,
	enabled: boolean,
) {
	const heightRef = useRef(0);
	const insetRef = useRef(keyboardInset);
	const animationRef = useRef<Animation | null>(null);
	const fillRef = useRef<HTMLDivElement | null>(null);
	const setStageRef = useCallback((stage: HTMLDivElement | null) => {
		stageRef.current = stage;
		if (!stage) return;
		heightRef.current = stage.offsetHeight;
		// Also track wrapping, picker navigation and rotation between keyboard updates.
		const observer = new ResizeObserver(() => { heightRef.current = stage.offsetHeight; });
		observer.observe(stage);
		return () => {
			observer.disconnect();
			animationRef.current?.cancel();
			animationRef.current = null;
			fillRef.current?.remove();
			fillRef.current = null;
			stageRef.current = null;
		};
	}, [stageRef]);

	useLayoutEffect(() => {
		const stage = stageRef.current;
		const previousInset = insetRef.current;
		insetRef.current = keyboardInset;
		if (!stage) return;
		if (!enabled || reducedMotion) {
			animationRef.current?.cancel();
			animationRef.current = null;
			fillRef.current?.remove();
			fillRef.current = null;
			heightRef.current = stage.offsetHeight;
			return;
		}
		if (previousInset === keyboardInset) return;
		const height = stage.offsetHeight;
		// A bottom-anchored surface moves up by the amount it grows. Preserve the
		// painted position when another viewport event interrupts its animation.
		const translate = getComputedStyle(stage).translate;
		const currentY = translate === 'none' ? 0 : Number.parseFloat(translate.split(' ')[1] ?? '0');
		const delta = height - heightRef.current + currentY;
		heightRef.current = height;
		animationRef.current?.cancel();
		animationRef.current = null;
		fillRef.current?.remove();
		fillRef.current = null;
		if (Math.abs(delta) < 0.5) return;
		// Individual translate leaves Motion's picker transform and the drawer's
		// entrance/swipe transform independent. Final layout is already in place.
		const timing = { duration: 180, easing: 'ease-out' };
		if (delta < 0) {
			// Closing the keyboard temporarily lifts the surface's bottom edge.
			// Cover that gap with a shrinking background layer, also without layout.
			const fill = stage.ownerDocument.createElement('div');
			fill.className = 'pwa-keyboard-motion-fill';
			fill.setAttribute('aria-hidden', 'true');
			fill.style.height = `${-delta}px`;
			stage.parentElement?.append(fill);
			fillRef.current = fill;
			const animation = fill.animate([{ transform: 'scaleY(1)' }, { transform: 'scaleY(0)' }], timing);
			animation.onfinish = () => { fill.remove(); if (fillRef.current === fill) fillRef.current = null; };
		}
		animationRef.current = stage.animate([
			{ translate: `0 ${delta}px` },
			{ translate: '0 0' },
		], timing);
	}, [enabled, keyboardInset, reducedMotion, stageRef]);

	return setStageRef;
}
