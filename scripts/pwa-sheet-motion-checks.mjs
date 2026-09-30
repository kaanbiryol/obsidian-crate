import { expect } from '@playwright/test';

// Observe after the frame's animation writers, and continue through removal so
// a late jump to the resting canvas cannot disappear from the recorded evidence.
export async function trackSheetDismissal(sheet, { minimumSettleMs = 0, recedeCanvas = true } = {}) {
	const recording = await sheet.evaluateHandle(popup => {
		const canvas = document.querySelector('.crate-modal-canvas');
		const backdrop = popup.closest('.pwa-modal-sheet').querySelector('.pwa-modal-sheet__backdrop');
		const canvasBounds = canvas.getBoundingClientRect().toJSON();
		const frames = [];
		let afterRemoval = 0;
		let finish;
		const done = new Promise(resolve => { finish = resolve; });
		const sample = () => {
			const alive = popup.isConnected;
			// WebKit can advance the compositor between consecutive style reads.
			// Freeze each layer at the same timeline instant using its own start
			// time, so a genuinely late mirror still differs from the sheet.
			const timelineTime = document.timeline.currentTime;
			const running = [popup, canvas, backdrop].flatMap(el => el.getAnimations())
				.filter(animation => animation.playState === 'running' && animation.startTime !== null)
				.map(animation => ({ animation, startTime: animation.startTime, playbackRate: animation.playbackRate }));
			for (const { animation, startTime, playbackRate } of running) {
				animation.pause();
				animation.currentTime = (timelineTime - startTime) * playbackRate;
			}
			if (popup.hasAttribute('data-ending-style') || !alive) frames.push({
				time: performance.now(), alive,
				sheet: alive ? Math.max(0, Math.min(1, new DOMMatrix(getComputedStyle(popup).transform).f / (Number.parseFloat(getComputedStyle(popup).getPropertyValue('--pwa-sheet-travel')) || popup.offsetHeight))) : 1,
				canvas: (new DOMMatrix(getComputedStyle(canvas).transform).a - .94) / .06,
				canvasBounds: canvas.getBoundingClientRect().toJSON(), baselineBounds: canvasBounds,
				backdrop: alive ? 1 - Number(getComputedStyle(backdrop).opacity) : 1,
			});
			for (const { animation, startTime } of running) {
				animation.play();
				animation.startTime = startTime;
			}
			if (!alive && ++afterRemoval === 3) { finish(); return; }
			requestAnimationFrame(() => setTimeout(sample, 0));
		};
		requestAnimationFrame(() => setTimeout(sample, 0));
		return { frames, done };
	});
	return async () => {
		await expect(sheet).toHaveCount(0);
		const frames = await recording.evaluate(async ({ frames, done }) => { await done; return frames; });
		await recording.dispose();
		const visible = frames.filter(frame => frame.alive);
		expect(visible.some(frame => frame.sheet > .1 && frame.sheet < .9)).toBe(true);
		expect(visible.at(-1).sheet).toBeGreaterThan(.98);
		expect(visible.at(-1).canvas).toBeGreaterThan(.98);
		for (const frame of frames) {
			if (recedeCanvas) expect(Math.abs(frame.sheet - frame.canvas)).toBeLessThan(.08);
			else {
				// WebKit can round the restored document height by 1/64 CSS px.
				for (const key of ['x', 'y', 'width', 'height']) {
					expect(Math.abs(frame.canvasBounds[key] - frame.baselineBounds[key]), key).toBeLessThan(.1);
				}
			}
			expect(Math.abs(frame.sheet - frame.backdrop)).toBeLessThan(.08);
		}
		if (minimumSettleMs) {
			const start = visible[0];
			const settled = visible.find(frame => frame.sheet >= start.sheet + (1 - start.sheet) * .9);
			expect(settled.time - start.time).toBeGreaterThanOrEqual(minimumSettleMs);
		}
		return frames;
	};
}
