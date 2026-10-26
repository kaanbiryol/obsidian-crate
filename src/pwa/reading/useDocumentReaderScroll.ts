import { useLayoutEffect } from 'react';
import { suspendDocumentScroll } from '../navigation/document-scroll';

/** Give iOS the document scroll view while the phone reader is open. */
export function useDocumentReaderScroll(enabled: boolean, articleId: string | undefined) {
	useLayoutEffect(() => {
		if (!enabled || !articleId) return;
		const reader = document.querySelector<HTMLElement>('.pwa-reading-root .crate-reading-reader');
		if (!reader) return;
		// Return a list screen's document offset to it before the reader takes over.
		const resume = suspendDocumentScroll();
		const top = reader.scrollTop;
		reader.dataset.documentScroll = 'true';
		document.documentElement.classList.add('pwa-document-reader');
		window.scrollTo({ top, behavior: 'instant' });
		// Pin the header and floating actions once the opening slide settles, so iOS
		// rubber-banding moves only the article. The sliding pane would otherwise
		// position fixed descendants against itself.
		const navigation = reader.querySelector<HTMLElement>('.crate-reading-reader__nav');
		const measure = () => { if (navigation) reader.style.setProperty('--reader-navigation-height', `${navigation.offsetHeight}px`); };
		// Resizing the reader inside the observer callback would trip its loop limit.
		let frame = 0;
		const resize = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); });
		let cancelled = false;
		const slides = reader.closest('.crate-reading__reader-pane')?.getAnimations()
			.filter(animation => 'transitionProperty' in animation && animation.transitionProperty === 'transform') ?? [];
		void Promise.allSettled(slides.map(animation => animation.finished)).then(() => {
			if (cancelled || !navigation) return;
			measure();
			resize.observe(navigation);
			reader.dataset.pinnedChrome = 'true';
		});
		return () => {
			cancelled = true;
			resize.disconnect();
			cancelAnimationFrame(frame);
			delete reader.dataset.pinnedChrome;
			reader.style.removeProperty('--reader-navigation-height');
			const top = window.scrollY;
			delete reader.dataset.documentScroll;
			document.documentElement.classList.remove('pwa-document-reader');
			window.scrollTo({ top: 0, behavior: 'instant' });
			// Keep the retained article at the same passage during its exit animation.
			reader.scrollTop = top;
			resume();
		};
	}, [enabled, articleId]);
}
