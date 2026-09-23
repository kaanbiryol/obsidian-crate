import { useEffect, type RefObject } from 'react';

/** Modes are roots. Only an open article has a swipe-back destination. */
export function usePwaBackGesture(root: RefObject<HTMLElement | null>): void {
	useEffect(() => {
		const start = (event: TouchEvent) => {
			if (!event.cancelable || event.touches.length !== 1 || event.touches[0]!.clientX > 20) return;
			if (!(event.target instanceof Node) || !root.current?.contains(event.target)) return;
			const article = root.current.querySelector('[data-crate-section="reading"][data-active="true"] .crate-reading-workspace[data-reader-open="true"]');
			const entry = history.state as { readingArticle?: boolean } | null;
			if (article && entry?.readingArticle === true) return;
			// iOS decides whether to begin native history navigation at touchstart.
			// Keep this limited to the left edge and single-finger gestures.
			event.preventDefault();
		};
		document.addEventListener('touchstart', start, { passive: false });
		return () => document.removeEventListener('touchstart', start);
	}, [root]);
}
