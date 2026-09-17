import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function checkEditorOpeningGeometry(browser, origin, reducedMotion) {
	const page = await browser.newPage({ viewport: { width: 393, height: 852 }, hasTouch: true, reducedMotion });
	try {
		await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
		const card = page.getByRole('group', { name: 'Tighten the PWA layout. Press Enter to edit reminder.', exact: true });
		await card.waitFor();
		await page.evaluate(() => {
			window.editorOpeningFrames = [];
			window.editorKeyboardHeight = 852;
			const viewport = new EventTarget();
			Object.defineProperties(viewport, {
				height: { get: () => window.editorKeyboardHeight },
				width: { value: 393 }, offsetTop: { value: 0 }, offsetLeft: { value: 0 },
				scale: { value: 1 }, pageTop: { value: 0 }, pageLeft: { value: 0 },
			});
			Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
			let started;
			document.addEventListener('click', () => { started = performance.now(); }, { capture: true, once: true });
			const sample = () => {
				const popup = document.querySelector('.pwa-modal-sheet__container');
				if (popup && started !== undefined) {
					const description = popup.querySelector('.reminder-description-input');
					const rows = ['.reminder-modal-header', '.reminder-editor-fields', '.reminder-action-chips'];
					const surface = popup.querySelector('.pwa-reminder-sheet-stage');
					const transform = getComputedStyle(popup).transform;
					window.editorOpeningFrames.push({
						travel: transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42,
						surfaceHeight: surface.offsetHeight,
						height: Number.parseFloat(popup.style.getPropertyValue('--pwa-editor-content-height')),
						expectedHeight: rows.reduce((sum, selector) => sum + popup.querySelector(selector).offsetHeight, 2),
						descriptionHeight: description.offsetHeight,
						description: description.value,
					});
				}
				if (started === undefined || performance.now() - started < 650) requestAnimationFrame(sample);
				else window.editorOpeningComplete = true;
			};
			requestAnimationFrame(sample);
		});
		await card.tap();
		await page.waitForFunction(() => window.editorOpeningComplete);
		const frames = await page.evaluate(() => window.editorOpeningFrames);
		assert.ok(frames.length > 3, 'record the entrance, not just its final frame');
		for (const frame of frames) {
			assert.ok(frame.travel <= frame.surfaceHeight + 33,
				`A compact sheet must travel by its visible height, not by the full-screen positioning frame (${frame.travel} vs ${frame.surfaceHeight})`);
			assert.equal(frame.height, frame.expectedHeight, 'description and sheet must be sized together before every painted frame');
			assert.equal(frame.height, frames[0].height, 'editor content must not grow during the entrance');
			assert.equal(frame.descriptionHeight, frames[0].descriptionHeight, 'description has its full height from the first frame');
			assert.equal(frame.description, 'Reduce vertical chrome, fix card spacing, and make the sheet feel native on iPhone.');
		}
		await expect(page.getByRole('textbox', { name: 'Reminder title', exact: true })).toBeFocused();
		const stage = page.locator('.pwa-reminder-sheet-stage');
		const original = await stage.boundingBox();
		await page.evaluate(() => {
			window.editorKeyboardHeight = 532;
			window.visualViewport.dispatchEvent(new Event('resize'));
		});
		// Wait for the first keyboard movement, then model its final 30px report
		// arriving after the drawer's entrance transition has already finished.
		await expect.poll(async () => Math.round((await stage.boundingBox()).y)).toBe(Math.round(original.y - 336));
		await expect(page.locator('.pwa-modal-sheet__container')).toHaveCSS('transform', 'none');
		const lateFrames = await page.evaluate(async () => {
			const stage = document.querySelector('.pwa-reminder-sheet-stage');
			const positions = [stage.getBoundingClientRect().top];
			window.editorKeyboardHeight = 502;
			window.visualViewport.dispatchEvent(new Event('resize'));
			const started = performance.now();
			await new Promise(resolve => {
				const sample = () => {
					positions.push(stage.getBoundingClientRect().top);
					if (performance.now() - started < 350) requestAnimationFrame(sample);
					else resolve();
				};
				requestAnimationFrame(sample);
			});
			return positions;
		});
		assert.ok(Math.abs(lateFrames[0] - lateFrames.at(-1) - 30) < 1, 'editor ends above the final keyboard position');
		if (reducedMotion === 'no-preference') {
			assert.ok(lateFrames.filter(y => y < lateFrames[0] - 1 && y > lateFrames.at(-1) + 1).length >= 3,
				`late keyboard geometry must move through intermediate frames instead of snapping (${lateFrames})`);
		}
		await page.getByRole('button', { name: 'Close reminder editor', exact: true }).click();
		await expect(page.locator('.pwa-modal-sheet')).toHaveCount(0);
	} finally {
		await page.close();
	}
}
