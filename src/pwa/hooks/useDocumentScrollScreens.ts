import { useEffect } from 'react';
import { isIosOrIpados } from '../config';
import {
	claimDocumentScroll, documentScrollOwner, documentScrollSuspended, onDocumentScrollResume, releaseDocumentScroll,
} from '../navigation/document-scroll';

const SCREEN_SCROLLERS = '.crate-feature-panel[data-active="true"] :is(.reminders-view-scroll, .crate-reading__list-scroll)';
const MOVING = '[data-leaving="true"], [data-entering="true"], [data-preparing="true"], [inert], [aria-hidden="true"]';
const OBSERVED_ATTRIBUTES = ['inert', 'aria-hidden', 'data-active', 'data-front', 'data-leaving', 'data-entering', 'data-preparing', 'data-project-open'];
// Wait for scrolling, touches and screen motion to finish before moving the scroll owner.
const SETTLE_MS = 150;

function editing(document: Document): boolean {
	const active = document.activeElement;
	return active instanceof HTMLElement && (active.isContentEditable || active.matches('input, textarea, select'));
}

/** The visible screen's list, if nothing is transitioning over or around it. */
function settledScroller(document: Document): HTMLElement | undefined {
	const candidates = Array.from(document.querySelectorAll<HTMLElement>(SCREEN_SCROLLERS))
		.filter(scroller => !scroller.closest(MOVING) && scroller.getClientRects().length > 0);
	// A pushed project screen covers the list behind it.
	const scroller = candidates.at(-1);
	if (!scroller) return undefined;
	for (let current: HTMLElement | null = scroller.parentElement; current && current !== document.body; current = current.parentElement) {
		if (current.classList.contains('pwa-tab-transition') && current.children.length !== 1) return undefined;
		const style = getComputedStyle(current);
		if (style.transform !== 'none' || style.filter !== 'none' || style.willChange.includes('transform')) return undefined;
	}
	return scroller;
}

/** Let the phone list screens own the document scroll on iOS, as the reader does. */
export function useDocumentScrollScreens(): void {
	useEffect(() => {
		if (!isIosOrIpados()) return;
		const phone = window.matchMedia('(max-width: 759px)');
		let touching = false;
		let width = window.innerWidth;
		let timer: number | undefined;

		const target = () => {
			if (!phone.matches || documentScrollSuspended() || editing(document)) return undefined;
			return settledScroller(document);
		};
		const promote = () => {
			timer = undefined;
			const scroller = target();
			// Script-driven screen motion ends without an event; check again until it settles.
			if (!scroller && phone.matches && !documentScrollSuspended() && document.querySelector(SCREEN_SCROLLERS)) schedule();
			if (!scroller || touching || documentScrollOwner() === scroller) return;
			const boundary = scroller.closest<HTMLElement>('.crate-feature-panel');
			if (boundary) claimDocumentScroll(scroller, boundary);
		};
		const schedule = () => {
			if (timer !== undefined) window.clearTimeout(timer);
			timer = window.setTimeout(promote, SETTLE_MS);
		};
		// Release before the next paint whenever the owner stops being the settled screen.
		const evaluate = () => {
			const current = documentScrollOwner();
			if (current && (!current.isConnected || target() !== current)) releaseDocumentScroll();
			if (!documentScrollOwner()) schedule();
		};
		const release = () => { releaseDocumentScroll(); schedule(); };
		// Safari's collapsing toolbars resize the height while the document scrolls.
		const resize = () => {
			if (window.innerWidth === width) return;
			width = window.innerWidth;
			release();
		};
		const touchStart = () => { touching = true; };
		const touchEnd = (event: TouchEvent) => {
			if (event.touches.length > 0) return;
			touching = false;
			schedule();
		};
		// Embedded scrolling, including momentum, must finish before the handoff.
		const scroll = (event: Event) => { if (!documentScrollOwner() && event.target !== document) schedule(); };

		// The feature shell mounts once the connection gate opens.
		const observer = new MutationObserver(evaluate);
		observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: OBSERVED_ATTRIBUTES });
		const stopResume = onDocumentScrollResume(schedule);
		document.addEventListener('touchstart', touchStart, { passive: true, capture: true });
		document.addEventListener('touchend', touchEnd, { passive: true, capture: true });
		document.addEventListener('touchcancel', touchEnd, { passive: true, capture: true });
		document.addEventListener('scroll', scroll, { passive: true, capture: true });
		document.addEventListener('focusin', evaluate);
		document.addEventListener('focusout', schedule);
		document.addEventListener('transitionend', schedule);
		window.addEventListener('resize', resize);
		phone.addEventListener('change', release);
		schedule();
		return () => {
			observer.disconnect();
			stopResume();
			if (timer !== undefined) window.clearTimeout(timer);
			document.removeEventListener('touchstart', touchStart, true);
			document.removeEventListener('touchend', touchEnd, true);
			document.removeEventListener('touchcancel', touchEnd, true);
			document.removeEventListener('scroll', scroll, true);
			document.removeEventListener('focusin', evaluate);
			document.removeEventListener('focusout', schedule);
			document.removeEventListener('transitionend', schedule);
			window.removeEventListener('resize', resize);
			phone.removeEventListener('change', release);
			releaseDocumentScroll();
		};
	}, []);
}
