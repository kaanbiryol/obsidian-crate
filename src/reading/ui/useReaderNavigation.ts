import { readerScrollElement } from './reader-scroll';
import { useEffect, type RefObject } from 'react';

/** Keep the PWA reader's sticky actions out of the way until scrolling reverses. */
export function useReaderNavigation(article: RefObject<HTMLElement | null>, enabled: boolean, articleId: string) {
	useEffect(() => {
		const scroller = article.current;
		const navigation = scroller?.querySelector<HTMLElement>('.crate-reading-reader__nav');
		const ownerWindow = scroller?.ownerDocument.defaultView;
		if (!enabled || !scroller || !navigation || !ownerWindow) return;
		const floating = scroller.querySelector<HTMLElement>('.crate-reading-reader__floating');
		const setHidden = (hidden: boolean) => {
			const value = String(hidden);
			if (navigation.dataset.scrollHidden !== value) navigation.dataset.scrollHidden = value;
			if (floating && floating.dataset.scrollHidden !== value) floating.dataset.scrollHidden = value;
		};
		let visibility = -1;
		const setVisibility = (value: number) => {
			const next = Math.max(0, Math.min(1, value));
			if (next === visibility) return;
			visibility = next;
			navigation.style.setProperty('--reader-navigation-visibility', String(visibility));
			floating?.style.setProperty('--reader-floating-visibility', String(visibility));
		};
		// Match one pixel of header movement to one pixel of scrolling, including
		// the status-bar inset. Keep layout measurements out of the scroll handler.
		let revealDistance = 1;
		const measure = () => {
			revealDistance = Math.max(1, navigation.offsetHeight + (parseFloat(ownerWindow.getComputedStyle(navigation).top) || 0));
		};
		measure();
		const resize = new ResizeObserver(measure);
		resize.observe(navigation);
		ownerWindow.addEventListener('resize', measure);
		let previous = readerScrollElement(scroller).scrollTop;
		let travel = 0;
		const reveal = () => { setHidden(false); setVisibility(1); travel = 0; };
		const onScroll = (event: Event) => {
			if (event.target !== scroller && event.target !== scroller.ownerDocument) return;
			// Clamp rubber-band overscroll so bouncing at either edge cannot reverse the header.
			if (scroller.ownerDocument.body.classList.contains('pwa-sheet-scroll-locked')) return;
			const scrollElement = readerScrollElement(scroller);
			const top = Math.max(0, Math.min(scrollElement.scrollTop, scrollElement.scrollHeight - scrollElement.clientHeight));
			const delta = top - previous;
			previous = top;
			if (top === 0) { reveal(); return; }
			if (!delta) return;
			const continuing = Math.sign(delta) === Math.sign(travel);
			const previousTravel = continuing ? Math.abs(travel) : 0;
			travel = continuing ? travel + delta : delta;
			// Filter jitter only at the fully shown/hidden endpoints. A partial
			// reveal follows reversals immediately instead of sticking for 12px.
			const threshold = visibility === 0 || visibility === 1 ? 12 : 0;
			const distance = Math.max(0, Math.abs(travel) - threshold) - Math.max(0, previousTravel - threshold);
			if (distance > 0) {
				setHidden(travel > 0);
				setVisibility(visibility - Math.sign(travel) * distance / revealDistance);
			}
		};
		reveal();
		scroller.ownerDocument.addEventListener('scroll', onScroll, { passive: true, capture: true });
		navigation.addEventListener('focusin', reveal);
		floating?.addEventListener('focusin', reveal);
		return () => {
			resize.disconnect();
			ownerWindow.removeEventListener('resize', measure);
			scroller.ownerDocument.removeEventListener('scroll', onScroll, true);
			navigation.removeEventListener('focusin', reveal);
			floating?.removeEventListener('focusin', reveal);
			if (floating) { delete floating.dataset.scrollHidden; floating.style.removeProperty('--reader-floating-visibility'); }
			delete navigation.dataset.scrollHidden;
			navigation.style.removeProperty('--reader-navigation-visibility');
		};
	}, [article, enabled, articleId]);
}
