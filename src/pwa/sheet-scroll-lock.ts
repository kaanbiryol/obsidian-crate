let lockCount = 0;
let restoreDocument: (() => void) | undefined;

/** Lock the page, without intercepting selection or scrolling inside the sheet. */
export function lockSheetDocumentScroll(): () => void {
	if (lockCount++ === 0) {
		const body = document.body;
		const root = document.documentElement;
		const viewport = window.visualViewport;
		let layoutWidth = window.innerWidth;
		let layoutHeight = Math.max(window.innerHeight, root.clientHeight, viewport?.height ?? 0);
		const scrollX = window.scrollX;
		const scrollY = window.scrollY;
		const properties = ['top', 'left'] as const;
		const original = properties.map(property => ({
			property,
			value: body.style.getPropertyValue(property),
			priority: body.style.getPropertyPriority(property),
		}));
		body.classList.add('pwa-sheet-scroll-locked');
		body.style.setProperty('top', `${-scrollY}px`, 'important');
		body.style.setProperty('left', `${-scrollX}px`, 'important');
		const preserveLayoutHeight = () => {
			if (window.innerWidth !== layoutWidth) {
				layoutWidth = window.innerWidth;
				layoutHeight = Math.max(window.innerHeight, root.clientHeight, viewport?.height ?? 0);
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
			root.style.removeProperty('--pwa-sheet-layout-height');
			for (const { property, value, priority } of original) {
				if (value) body.style.setProperty(property, value, priority);
				else body.style.removeProperty(property);
			}
			window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
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
