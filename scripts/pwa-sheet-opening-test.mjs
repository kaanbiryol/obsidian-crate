import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';
import { checkEditorOpeningGeometry } from './pwa-editor-opening-geometry.mjs';
import { checkPickerReturnTiming } from './pwa-picker-return-timing.mjs';

async function trackOpening(page, content, animated) {
	await page.evaluate(({ content, animated }) => {
		cancelAnimationFrame(window.sheetOpeningFrame);
		window.sheetOpeningSamples = [];
		window.sheetOpeningStartedAt = null;
		window.sheetOpeningDelay = null;
		document.addEventListener('click', () => { window.sheetOpeningStartedAt = performance.now(); }, { once: true, capture: true });
		function sample() {
			const surface = document.querySelector(content);
			const element = document.querySelector(animated);
			if (surface && element && window.sheetOpeningStartedAt !== null) {
				window.sheetOpeningDelay ??= performance.now() - window.sheetOpeningStartedAt;
				const transform = getComputedStyle(element).transform;
				window.sheetOpeningSamples.push(transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42);
			}
			window.sheetOpeningFrame = requestAnimationFrame(sample);
		}
		window.sheetOpeningFrame = requestAnimationFrame(sample);
	}, { content, animated });
}

async function expectAnimatedOpening(page, label, maxStartDelay) {
	const { samples, delay } = await page.evaluate(() => {
		cancelAnimationFrame(window.sheetOpeningFrame);
		return { samples: window.sheetOpeningSamples, delay: window.sheetOpeningDelay };
	});
	assert.ok(samples.filter(y => y > 10).length >= 3,
		`${label}: content must travel through intermediate frames instead of appearing at rest (${samples})`);
	assert.ok(samples.at(-1) < 1, `${label}: the entrance must finish`);
	if (maxStartDelay) assert.ok(delay < maxStartDelay,
		`${label}: a prepared picker must start after the 180 ms editor exit without an extra loading pause (${delay} ms)`);
}

const pickers = [
	{ button: 'Inbox', dialog: 'Select project', selector: '.pwa-project-picker-sheet' },
	{ button: 'Date', dialog: 'Schedule reminder', selector: '.pwa-date-picker-sheet' },
	{ button: 'Recurrence', dialog: 'Repeat reminder', selector: '.pwa-repeat-picker-sheet' },
];
const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
try {
	for (const browserType of [chromium, webkit]) {
		const browser = await browserType.launch();
		try {
			for (const reducedMotion of ['no-preference', 'reduce']) {
				await checkEditorOpeningGeometry(browser, origin, reducedMotion);
				for (const picker of pickers) {
					// Each picker must be the first lazy sheet in a fresh app instance.
					const page = await browser.newPage({
						viewport: { width: 390, height: 844 }, hasTouch: true,
						serviceWorkers: 'block', reducedMotion,
					});
					try {
						await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
						const card = page.getByRole('group', { name: 'Check this article. Press Enter to edit reminder.', exact: true });
						await card.waitFor();
						let pickerRequests = 0;
						let loadedDuringEntrance = false;
						const pendingPickerRequests = new Set();
						page.on('requestfinished', request => pendingPickerRequests.delete(request));
						page.on('requestfailed', request => pendingPickerRequests.delete(request));
						// Slow assets from the editor's warm-up onward, so an immediate
						// chip tap still exercises the content-readiness guard.
						await page.route('**/notifications/assets/*.js', async route => {
							pendingPickerRequests.add(route.request());
							pickerRequests++;
							loadedDuringEntrance ||= await page.evaluate(() =>
								document.querySelector('.pwa-modal-sheet__container')?.getAnimations()
									.some(animation => animation.playState === 'running') ?? false);
							await new Promise(resolve => setTimeout(resolve, 1200));
							await route.continue();
						});
						await trackOpening(page, '.pwa-reminder-sheet-stage', '.pwa-modal-sheet__container');
						await card.tap();
						await expect(page.locator('.pwa-modal-sheet__container')).toHaveCSS('transform', 'none');
						if (reducedMotion === 'no-preference') await expectAnimatedOpening(page, 'First editor');
						const editor = page.getByRole('dialog', { name: 'Edit reminder', exact: true });
						const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
						await title.fill('Keep this draft through the first load');

						await expect.poll(() => pickerRequests,
							{ message: 'Picker assets should start loading before a picker is selected' }).toBeGreaterThan(0);
						assert.equal(loadedDuringEntrance, false, 'Picker warm-up must wait for the editor entrance to finish');
						const preparedSchedule = picker.button === 'Date' && reducedMotion === 'no-preference';
						// Also cover a user who spends time editing before the first chip
						// tap: cached code must not incur React's initial fallback delay.
						if (preparedSchedule) {
							// Network idle can fire while a route is deliberately paused.
							// Wait for the actual assets before testing a prepared picker.
							await expect.poll(() => pendingPickerRequests.size).toBe(0);
							await page.waitForLoadState('networkidle');
						}
						for (let opening = 0; opening < 2; opening++) {
							await trackOpening(page, picker.selector, '.pwa-reminder-sheet-stage');
							await editor.getByRole('button', { name: picker.button, exact: true }).tap();
							await expect(page.getByRole('dialog', { name: picker.dialog, exact: true })).toBeVisible();
							await expect(page.locator('.pwa-reminder-sheet-stage')).toHaveCSS('transform', 'none');
							if (reducedMotion === 'no-preference') await expectAnimatedOpening(page,
								`${picker.dialog}, opening ${opening + 1}`, preparedSchedule ? 370 : undefined);
							// A zero transform can precede Motion's completion callback by a frame.
							await expect(page.locator('.pwa-modal-sheet__container')).not.toHaveAttribute('data-base-ui-swipe-ignore');
							await checkPickerReturnTiming(page, reducedMotion, `${browserType.name()} ${picker.dialog} ${reducedMotion}`);
							await expect(page.getByRole('dialog', { name: picker.dialog, exact: true })).toHaveCount(0);
							await expect(page.locator('.pwa-reminder-sheet-stage')).toHaveCSS('transform', 'none');
							await expect(title).toHaveText('Keep this draft through the first load');
						}
						await page.touchscreen.tap(195, 20);
						await expect(page.locator('.pwa-modal-sheet')).toHaveCount(0);
						await expect(page.locator('body')).not.toHaveClass(/pwa-sheet-scroll-locked/);
					} finally {
						await page.close();
					}
				}
			}
			console.log(`${browserType.name()}: cold and warm picker entrances, editor entrance, reduced motion and draft preservation passed`);
		} finally {
			await browser.close();
		}
	}
} finally {
	await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
