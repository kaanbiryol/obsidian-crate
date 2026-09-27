import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

export async function checkSaveLinkKeyboard(page) {
	const field = page.getByLabel('Link', { exact: true });
	const popup = page.getByRole('dialog', { name: 'Save a link', exact: true });
	await expect(field).toBeFocused();
	await expect(popup).toHaveCSS('transform', 'none');
	const baseline = await page.locator('.crate-modal-canvas').boundingBox();
	const surface = popup.locator('.pwa-sheet-surface');
	const original = await surface.boundingBox();
	// Desktop engines have no software keyboard. Model its viewport report,
	// then verify the sheet moves while the underlying app stays stationary.
	await page.evaluate(() => {
		window.sheetOriginalViewport = window.visualViewport;
		const viewport = new EventTarget();
		Object.defineProperties(viewport, {
			height: { value: window.innerHeight - 300 }, width: { value: window.innerWidth },
			offsetTop: { value: 0 }, offsetLeft: { value: 0 }, scale: { value: 1 },
		});
		Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
		window.dispatchEvent(new Event('resize'));
	});
	try {
		await expect(popup.locator('.pwa-sheet-surface')).toHaveCSS('padding-bottom', '300px');
		await expect(popup).toHaveCSS('bottom', '0px');
		await expect.poll(async () => { const box = await popup.boundingBox(); return Math.round(box.y + box.height); }).toBe(page.viewportSize().height);
		await expect.poll(async () => Math.round((await surface.boundingBox()).height - original.height)).toBe(300);
		await expect.poll(async () => { const box = await surface.boundingBox(); return Math.round(box.y + box.height); }).toBe(page.viewportSize().height);
		assert.deepEqual(await page.locator('.crate-modal-canvas').boundingBox(), baseline);
		await expect.poll(async () => { const box = await field.boundingBox(); return box.y >= 0 && box.y + box.height <= page.viewportSize().height - 300; }).toBe(true);
		for (const selector of ['.pwa-modal-sheet', '.pwa-modal-sheet__container', '.pwa-modal-sheet__content', '.pwa-modal-sheet__scroller']) {
			await expect(page.locator(selector)).toHaveCSS('overflow-y', 'clip');
		}
		await field.evaluate(element => {
			element.blur();
			const focus = element.focus.bind(element);
			element.focus = options => { element.dataset.preventScroll = String(options?.preventScroll); focus(options); };
		});
		await field.tap();
		await expect(field).toBeFocused();
		await expect(field).toHaveAttribute('data-prevent-scroll', 'true');
		assert.deepEqual(await page.locator('.crate-modal-canvas').boundingBox(), baseline);
	} finally {
		await page.evaluate(() => {
			Object.defineProperty(window, 'visualViewport', { configurable: true, value: window.sheetOriginalViewport });
			delete window.sheetOriginalViewport;
			window.dispatchEvent(new Event('resize'));
		});
	}
	await expect(popup.locator('.pwa-sheet-surface')).toHaveCSS('padding-bottom', '0px');
	await page.getByRole('button', { name: 'Close save a link', exact: true }).click();
	await expect(popup).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Save a link', exact: true })).toBeFocused();
	await page.getByRole('button', { name: 'Save a link', exact: true }).tap();
	await expect(field).toBeFocused();
}
