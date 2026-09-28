import { expect } from '@playwright/test';

// Follow the full drag and re-grab a sheet while it is settling. The library's
// gesture-relative progress restarts at zero; the visible position must not.
export async function checkSheetDragPosition(page, sheet, { recedeCanvas = true } = {}) {
	await page.mouse.move(-10, -10);
	const frames = await sheet.evaluate(async popup => {
		const target = popup.querySelector('.reminder-modal-header-title');
		const canvas = document.querySelector('.crate-modal-canvas');
		const travel = () => Number.parseFloat(getComputedStyle(popup).getPropertyValue('--pwa-sheet-travel')) || popup.offsetHeight;
		const samples = [];
		let time = performance.now();
		const frame = () => new Promise(requestAnimationFrame);
		const sample = () => samples.push({
			position: Math.max(0, Math.min(1, new DOMMatrix(getComputedStyle(popup).transform).f / travel())),
			scale: new DOMMatrix(getComputedStyle(canvas).transform).a,
			bounds: canvas.getBoundingClientRect().toJSON(),
		});
		sample();
		const dispatch = async (type, y) => {
			const touch = { identifier: 1, target, clientX: 180, clientY: y };
			const event = new Event(type, { bubbles: true, cancelable: true });
			Object.defineProperties(event, {
				timeStamp: { value: time += 70 },
				touches: { value: type === 'touchend' ? [] : [touch] }, changedTouches: { value: [touch] },
			});
			target.dispatchEvent(event);
			await frame(); sample();
		};
		let start = target.getBoundingClientRect().y + 10;
		await dispatch('touchstart', start);
		for (const fraction of [.05, .15, .3, .5, .65, .5, .3, .15, .08]) await dispatch('touchmove', start + travel() * fraction);
		await dispatch('touchend', start + travel() * .08);
		await frame();
		start = target.getBoundingClientRect().y + 10;
		await dispatch('touchstart', start);
		for (const fraction of [.02, .08, .15, .06, 0]) await dispatch('touchmove', start + travel() * fraction);
		await dispatch('touchend', start);
		return samples;
	});
	for (const frame of frames) {
		expect(Math.abs(frame.scale - (recedeCanvas ? .94 + .06 * frame.position : 1)), JSON.stringify(frame)).toBeLessThan(.002);
		if (!recedeCanvas) expect(frame.bounds).toEqual(frames[0].bounds);
	}
	await expect(sheet).toHaveCSS('transform', 'none');
}
