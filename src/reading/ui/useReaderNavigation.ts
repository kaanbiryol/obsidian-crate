import { readerScrollElement } from './reader-scroll';
import { useEffect, type RefObject } from 'react';

/** Keep the PWA reader's sticky actions out of the way until scrolling reverses. */
export function useReaderNavigation(article: RefObject<HTMLElement | null>, enabled: boolean, articleId: string) {
	useEffect(() => {
		const scroller = article.current;
		const navigation = scroller?.querySelector<HTMLElement>('.crate-reading-reader__nav');
		if (!enabled || !scroller || !navigation) return;
		const floating = scroller.querySelector<HTMLElement>('.crate-reading-reader__floating');
		const setHidden = (hidden: boolean) => {
			navigation.dataset.scrollHidden = String(hidden);
			if (floating) floating.dataset.scrollHidden = String(hidden);
		};
		let visibility = 1;
		const setVisibility = (value: number) => {
			visibility = Math.max(0, Math.min(1, value));
			floating?.style.setProperty('--reader-floating-visibility', String(visibility));
		};
		let previous = 0;
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
			if (top <= navigation.offsetHeight) { reveal(); return; }
			if (!delta) return;
			const continuing = Math.sign(delta) === Math.sign(travel);
			const previousTravel = continuing ? Math.abs(travel) : 0;
			travel = continuing ? travel + delta : delta;
			if (Math.abs(travel) >= 12) {
				setHidden(travel > 0);
				// Ignore tiny reversals, then follow the next 48px of the gesture.
				const distance = Math.max(0, Math.abs(travel) - 12) - Math.max(0, previousTravel - 12);
				setVisibility(visibility - Math.sign(travel) * distance / 48);
			}
		};
		reveal();
		scroller.ownerDocument.addEventListener('scroll', onScroll, { passive: true, capture: true });
		navigation.addEventListener('focusin', reveal);
		floating?.addEventListener('focusin', reveal);
		return () => {
			scroller.ownerDocument.removeEventListener('scroll', onScroll, true);
			navigation.removeEventListener('focusin', reveal);
			floating?.removeEventListener('focusin', reveal);
			if (floating) { delete floating.dataset.scrollHidden; floating.style.removeProperty('--reader-floating-visibility'); }
			delete navigation.dataset.scrollHidden;
		};
	}, [article, enabled, articleId]);
}
