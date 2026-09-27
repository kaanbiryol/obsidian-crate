let lockCount = 0;
let restoreDocument: (() => void) | undefined;

/** Lock the page, without intercepting selection or scrolling inside the sheet. */
export function lockSheetDocumentScroll(viewportPortal = false): () => void {
	if (lockCount++ === 0) {
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
		// A viewport portal is outside #app. Keep the body at the viewport origin
		// and offset only the article canvas, so WebKit never clips an offscreen body.
		const app = viewportPortal && root.classList.contains('pwa-document-reader')
			? document.getElementById('app') : null;
		const savedStyles = [
			...(['top', 'left'] as const).map(property => ({ element: body, property })),
			...(app ? (['top', 'left'] as const).map(property => ({ element: app, property })) : []),
		].map(({ element, property }) => ({ element, property,
			value: element.style.getPropertyValue(property), priority: element.style.getPropertyPriority(property),
		}));
		body.classList.add('pwa-sheet-scroll-locked');
		body.style.setProperty('top', `${app ? 0 : -scrollY}px`, 'important');
		body.style.setProperty('left', `${app ? 0 : -scrollX}px`, 'important');
		if (app) {
			app.classList.add('pwa-sheet-canvas-locked');
			app.style.setProperty('top', `${-scrollY}px`, 'important');
			app.style.setProperty('left', `${-scrollX}px`, 'important');
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
			app?.classList.remove('pwa-sheet-canvas-locked');
			root.style.removeProperty('--pwa-sheet-layout-height');
			for (const { element, property, value, priority } of savedStyles) {
				if (value) element.style.setProperty(property, value, priority);
				else element.style.removeProperty(property);
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
