import { suspendDocumentScroll } from './document-scroll';

let lockCount = 0;
let restoreDocument: (() => void) | undefined;

/** Lock the page, without intercepting selection or scrolling inside the sheet. */
export function lockSheetDocumentScroll(): () => void {
	if (lockCount++ === 0) {
		// A list screen returns its document offset first, so sheets recede it as usual.
		const resume = suspendDocumentScroll();
		const body = document.body;
		const root = document.documentElement;
		const viewport = window.visualViewport;
		let layoutWidth = window.innerWidth;
		// Under translucent iOS chrome, viewport APIs can exclude the status
		// bar even when CSS fills the screen. Freeze the rendered canvas too.
		const measureLayoutHeight = () => Math.max(window.innerHeight, root.clientHeight,
			root.getBoundingClientRect().height, viewport?.height ?? 0);
		let layoutHeight = measureLayoutHeight();
		const scrollX = window.scrollX;
		const scrollY = window.scrollY;
		// The phone reader scrolls the document. Fixing the body would move its
		// long article into a new layer, which iOS paints a frame late, showing
		// the library behind it. Hold the document at its offset instead.
		const hold = root.classList.contains('pwa-document-reader');
		const savedStyles = (hold ? [] : ['top', 'left'] as const).map(property => ({ property,
			value: body.style.getPropertyValue(property), priority: body.style.getPropertyPriority(property),
		}));
		if (hold) root.classList.add('pwa-sheet-scroll-held');
		else {
			body.classList.add('pwa-sheet-scroll-locked');
			body.style.setProperty('top', `${-scrollY}px`, 'important');
			body.style.setProperty('left', `${-scrollX}px`, 'important');
		}
		const preserveLayoutHeight = () => {
			if (window.innerWidth !== layoutWidth) {
				layoutWidth = window.innerWidth;
				layoutHeight = measureLayoutHeight();
			}
			// iOS standalone can change its layout height during field focus.
			// Keep the app and sheet at their pre-keyboard size until rotation.
			root.style.setProperty('--pwa-sheet-layout-height', `${layoutHeight}px`);
		};
		preserveLayoutHeight();
		window.addEventListener('resize', preserveLayoutHeight, { passive: true });

		restoreDocument = () => {
			window.removeEventListener('resize', preserveLayoutHeight);
			body.classList.remove('pwa-sheet-scroll-locked');
			root.classList.remove('pwa-sheet-scroll-held');
			root.style.removeProperty('--pwa-sheet-layout-height');
			for (const { property, value, priority } of savedStyles) {
				if (value) body.style.setProperty(property, value, priority);
				else body.style.removeProperty(property);
			}
			// Also returns a held document that a focused field scrolled.
			window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
			resume();
		};
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (--lockCount === 0) {
			restoreDocument?.();
			restoreDocument = undefined;
		}
	};
}
