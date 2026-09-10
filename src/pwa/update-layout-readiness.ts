const STABLE_LAYOUT_MS = 200;
const MAX_LAYOUT_WAIT_MS = 2_000;

/** Wait for startup geometry to settle before uncovering the updated document. */
export function whenUpdateLayoutSettles(onReady: () => void): () => void {
	const started = performance.now();
	let stableSince = started;
	let previous = '';
	let frame = 0;
	const sample = () => {
		const now = performance.now();
		const viewport = window.visualViewport;
		const geometry = [window.innerWidth, window.innerHeight,
			viewport?.height, viewport?.offsetTop,
			...Array.from(document.querySelectorAll(
				'#app, .view-header, .pwa-below-header-content, .reminders-content, .bottom-tab-bar',
			)).flatMap(element => {
				const rect = element.getBoundingClientRect();
				return [rect.x, rect.y, rect.width, rect.height];
			}),
		].join(',');
		if (geometry !== previous || document.fonts.status === 'loading') {
			previous = geometry;
			stableSince = now;
		}
		if (now - stableSince >= STABLE_LAYOUT_MS || now - started >= MAX_LAYOUT_WAIT_MS) {
			onReady();
			return;
		}
		frame = requestAnimationFrame(sample);
	};
	frame = requestAnimationFrame(sample);
	return () => cancelAnimationFrame(frame);
}
