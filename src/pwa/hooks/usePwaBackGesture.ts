import { useEffect, type RefObject } from 'react';

/** Pushed screens declare their back destination; roots and modal editors don't.
 * Native history owns tracking, cancellation and velocity for every edge swipe. */
export function usePwaBackGesture(root: RefObject<HTMLElement | null>): void {
	useEffect(() => {
		const start = (event: TouchEvent) => {
			if (!event.cancelable || event.touches.length !== 1 || event.touches[0]!.clientX > 20) return;
			if (!(event.target instanceof Element)) return;
			if (!root.current?.contains(event.target) && !event.target.closest('.pwa-sheet-portal')) return;
			const screen = event.target.closest('[data-pwa-back], [role="dialog"], [role="alertdialog"]');
			const entry = history.state as { pwaBackDestination?: string } | null;
			const covered = document.querySelector('.pwa-modal-sheet [aria-modal="true"]') && !event.target.closest('[aria-modal="true"]');
			if (!covered && screen?.getAttribute('data-pwa-back') === 'true' && entry?.pwaBackDestination && !event.target.closest('[inert]')) return;
			// iOS decides whether to begin native history navigation at touchstart.
			// Keep this limited to the left edge and single-finger gestures.
			event.preventDefault();
		};
		document.addEventListener('touchstart', start, { passive: false });
		return () => document.removeEventListener('touchstart', start);
	}, [root]);
}
