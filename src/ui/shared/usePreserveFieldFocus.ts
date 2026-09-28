import { useEffect, type RefObject } from 'react';

/** Keep taps on non-interactive space from taking focus away from an editor. */
export function usePreserveFieldFocus(ref: RefObject<HTMLElement | null>, enabled = true) {
	useEffect(() => {
		const element = ref.current;
		if (!enabled || !element) return;
		let moved = false;
		const startTouch = () => { moved = false; };
		const moveTouch = () => { moved = true; };
		const keepFocus = (event: Event) => {
			if (event.type === 'touchend' && moved) return;
			if (!(event.target instanceof Element)) return;
			const control = event.target.closest('button, input, textarea, select, a[href], label, [contenteditable="true"], [role="button"], [role="option"]');
			if (!control) event.preventDefault();
		};
		// Cancel focus transfer on taps only. Touchstart/move stay native so
		// sheet dragging, scrolling, fields and actions retain their behavior.
		element.addEventListener('touchstart', startTouch, { passive: true });
		element.addEventListener('touchmove', moveTouch, { passive: true });
		element.addEventListener('touchend', keepFocus, { passive: false });
		element.addEventListener('mousedown', keepFocus);
		return () => {
			element.removeEventListener('touchstart', startTouch);
			element.removeEventListener('touchmove', moveTouch);
			element.removeEventListener('touchend', keepFocus);
			element.removeEventListener('mousedown', keepFocus);
		};
	}, [enabled, ref]);
}
