/** Keep background depth tied to the painted sheet, including interrupted drags. */
export function trackSheetPresentation(popup: HTMLElement, recedeCanvas = true): () => void {
	// Focus must stay synchronous with the opening tap to activate iOS's keyboard.
	// Suppress only caret painting until its transformed ancestors have settled.
	popup.setAttribute('data-sheet-moving', '');
	const sheet = popup.closest<HTMLElement>('.pwa-modal-sheet');
	const backdrop = sheet?.querySelector<HTMLElement>('.pwa-modal-sheet__backdrop');
	const canvas = recedeCanvas ? sheet?.closest('.crate-feature-shell')?.querySelector<HTMLElement>('.crate-modal-canvas') : null;
	const depth = matchMedia('(max-width: 759px) and (prefers-reduced-motion: no-preference)');
	let frame = 0;
	let height = popup.offsetHeight;
	let disposed = false;
	let source: Animation | undefined;
	let sourceTravel = 0;
	let mirrors: Animation[] = [];
	const position = (transform: string, travel: number) => {
		// CSS transition keyframes retain percentage translations, whereas the
		// computed drag transform is already a matrix. These sheets move vertically.
		const resolved = transform.replace(/(-?\d+(?:\.\d+)?)%/g, (_, percent: string) => `${Number(percent) * height / 100}px`);
		const y = resolved === 'none' ? 0 : new DOMMatrixReadOnly(resolved).m42;
		return Math.max(0, Math.min(1, travel > 0 ? y / travel : 1));
	};
	const clearMirrors = () => {
		for (const mirror of mirrors) mirror.cancel();
		mirrors = [];
		source = undefined;
	};
	const schedule = () => {
		if (!disposed && !frame) frame = requestAnimationFrame(sample);
	};
	const sample = () => {
		frame = 0;
		if (disposed || !popup.isConnected) return;
		const style = getComputedStyle(popup);
		const travel = Number.parseFloat(style.getPropertyValue('--pwa-sheet-travel')) || height;
		const progress = String(position(style.transform, travel));
		canvas?.style.setProperty('--pwa-sheet-position', progress);
		backdrop?.style.setProperty('--pwa-sheet-position', progress);
		const transition = popup.getAnimations().find(animation =>
			'transitionProperty' in animation && animation.transitionProperty === 'transform' && animation.playState === 'running');
		popup.toggleAttribute('data-sheet-moving', Boolean(transition)
			|| popup.hasAttribute('data-starting-style') || popup.hasAttribute('data-ending-style') || popup.hasAttribute('data-swiping'));
		if (transition === source && sourceTravel === travel) return;
		clearMirrors();
		if (!transition?.effect) return;
		// A compositor-driven sheet can advance between JS frames. Mirror its
		// actual transition and timeline, not another animation started on close.
		if (transition.startTime === null) { schedule(); return; }
		source = transition;
		sourceTravel = travel;
		const keyframes = (transition.effect as KeyframeEffect).getKeyframes();
		const timing = { ...transition.effect.getTiming(), fill: 'both' as const };
		const depthCanvas = depth.matches && !document.documentElement.classList.contains('pwa-document-reader') ? canvas : null;
		if (depthCanvas) mirrors.push(depthCanvas.animate(keyframes.map(keyframe => {
			const p = position(String(keyframe.transform), travel);
			return { offset: keyframe.offset, easing: keyframe.easing,
				transform: `translateY(${8 * (1 - p)}px) scale(${.94 + .06 * p})`, borderRadius: `${24 * (1 - p)}px` };
		}), timing));
		if (backdrop) mirrors.push(backdrop.animate(keyframes.map(keyframe => ({
			offset: keyframe.offset, easing: keyframe.easing, opacity: 1 - position(String(keyframe.transform), travel),
		})), timing));
		for (const mirror of mirrors) mirror.startTime = transition.startTime;
		void transition.finished.then(schedule, schedule);
	};
	// Flush gesture writes before paint. Re-grabbing cancels the mirrored
	// transition and uses the sheet's absolute position, never a reset delta.
	const observer = new MutationObserver(() => { cancelAnimationFrame(frame); sample(); });
	observer.observe(popup, { attributes: true, attributeFilter: ['style', 'data-starting-style', 'data-ending-style', 'data-swiping'] });
	const resize = new ResizeObserver(() => { height = popup.offsetHeight; schedule(); });
	const mediaChanged = () => { clearMirrors(); schedule(); };
	resize.observe(popup);
	depth.addEventListener('change', mediaChanged);
	popup.addEventListener('transitionrun', schedule);
	popup.addEventListener('transitionend', schedule);
	popup.addEventListener('transitioncancel', schedule);
	schedule();
	return () => {
		disposed = true;
		cancelAnimationFrame(frame);
		clearMirrors();
		observer.disconnect();
		resize.disconnect();
		depth.removeEventListener('change', mediaChanged);
		popup.removeEventListener('transitionrun', schedule);
		popup.removeEventListener('transitionend', schedule);
		popup.removeEventListener('transitioncancel', schedule);
		popup.removeAttribute('data-sheet-moving');
		canvas?.style.removeProperty('--pwa-sheet-position');
		backdrop?.style.removeProperty('--pwa-sheet-position');
	};
}
