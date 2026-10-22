import { checkSheetDragPosition } from './pwa-sheet-drag-checks.mjs';
import { trackSheetDismissal } from './pwa-sheet-motion-checks.mjs';
import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from '../../../scripts/pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from '../../../scripts/pwa-preview-server.mjs';

import { swipe } from '../support/browser-touch-swipe.mjs';
import { recordSwipeDiagnostics, saveSwipeFailure } from '../support/browser-swipe-diagnostics.mjs';

const assets = await buildPwaPreviewAssets();
const { server, origin } = await listenPwaPreviewServer({ port: 0, assets });
try {
	for (const browserType of [chromium, webkit]) {
		const browser = await browserType.launch();
		let page;
		try {
			page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
			await recordSwipeDiagnostics(page);
			const errors = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
			const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
			await page.getByRole('button', { name: 'Open settings', exact: true }).waitFor();
			const interrupted = await page.evaluate(async () => {
				document.querySelector('[aria-label="Open settings"]').click();
				let sheet;
				while (!(sheet = document.querySelector('.pwa-modal-sheet__container'))) await new Promise(resolve => requestAnimationFrame(resolve));
				// Wait for the entrance to paint instead of assuming CI starts it in 80ms.
				const started = performance.now();
				while (new DOMMatrixReadOnly(getComputedStyle(sheet).transform).m42 >= sheet.getBoundingClientRect().height - 1
					&& performance.now() - started < 2000) await new Promise(requestAnimationFrame);
				const y = () => new DOMMatrixReadOnly(getComputedStyle(sheet).transform).m42;
				const before = y(), height = sheet.getBoundingClientRect().height;
				sheet.querySelector('[aria-label="Close settings"]').click();
				// Dismissal commits synchronously. Measure its starting position in the
				// same frame; a delayed next frame includes legitimate exit travel.
				const after = y();
				return { before, after, height };
			});
			assert.ok(interrupted.before > 1 && interrupted.before < interrupted.height - 1, JSON.stringify(interrupted));
			assert.ok(Math.abs(interrupted.after - interrupted.before) < interrupted.height * .15, 'Closing during entrance must start at the painted position');
			await expect(settings).toHaveCount(0);
			await expect(page.locator('body')).not.toHaveClass(/pwa-sheet-scroll-locked/);
			await page.getByRole('button', { name: 'Open settings', exact: true }).tap();
			await expect(settings).toHaveCSS('transform', 'none');
			await swipe(page, settings.getByRole('heading', { name: 'Settings', exact: true }), 16, 400);
			await expect(settings).toHaveCSS('transform', 'none');
			await expect(settings).toBeVisible();
			await swipe(page, settings.getByRole('heading', { name: 'Settings', exact: true }));
			await expect(settings).toHaveCount(0);
			await expect(page.locator('body')).not.toHaveClass(/pwa-sheet-scroll-locked/);

			// As on iOS, content scrolled to its top hands a downward drag to the sheet.
			await page.getByRole('button', { name: 'Open settings', exact: true }).tap();
			await expect(settings).toHaveCSS('transform', 'none');
			const settingsBody = settings.locator('.settings-main');
			await settingsBody.evaluate(element => { element.scrollTop = 300; });
			await swipe(page, settingsBody);
			await expect(settings).toBeVisible();
			await expect(settings).toHaveCSS('transform', 'none');
			await settingsBody.evaluate(element => { element.scrollTop = 0; });
			await swipe(page, settingsBody);
			await expect(settings).toHaveCount(0);
			await expect(page.locator('body')).not.toHaveClass(/pwa-sheet-scroll-locked/);

			const card = page.getByRole('group', { name: 'Check this article. Press Enter to edit reminder.', exact: true });
			const cardBox = await card.boundingBox();
			assert.ok(cardBox);
			await card.tap();
			const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
			const editor = page.getByRole('dialog', { name: 'Edit reminder', exact: true });
			await expect(editor).toHaveCSS('transform', 'none');
			const canvas = page.locator('.crate-modal-canvas');
			const scale = () => canvas.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a);
			await expect.poll(scale).toBe(1);
			await expect(canvas).toHaveCSS('transform', 'none');
			assert.equal(await editor.evaluate(el => Boolean(el.closest('.crate-modal-canvas'))), false, 'The sheet must not inherit the background scale');
			await expect(page.locator('.pwa-modal-sheet__backdrop')).toHaveCSS('transition-duration', '0s');
			await checkSheetDragPosition(page, editor, { recedeCanvas: false });
			await title.fill('Keep my swiped draft');
			// A short, slow drag from a focused field moves the sheet, then settles back.
			await swipe(page, title, 40, 600);
			await expect(editor).toBeVisible();
			await expect(editor).toHaveCSS('transform', 'none');
			await expect(title).toHaveText('Keep my swiped draft');
			await page.evaluate(() => document.getSelection()?.collapseToEnd());
			// WebKit can focus-scroll the invisible containment layer to its end.
			// That must not prevent the next header drag from dismissing the sheet.
			await page.locator('.pwa-modal-sheet__scroll-boundary').evaluate(element => { element.scrollTop = 1; });
			// Reproduce the stale desktop hover that used to interrupt the simulated
			// finger when the sheet moved underneath the cursor.
			await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
			const checkDismissal = await trackSheetDismissal(editor, { recedeCanvas: false });
			await swipe(page, editor.getByRole('heading', { name: 'Edit reminder', exact: true }));
			await checkDismissal();
			await expect(editor).toHaveCount(0);
			await expect.poll(scale).toBe(1);
			await card.tap();
			await expect(title).toHaveText('Keep my swiped draft');
			// As on iOS, content at its top hands a downward drag to the sheet, even
			// from a focused field, and dismissal keeps the draft.
			await expect(editor).toHaveCSS('transform', 'none');
			await title.focus();
			await swipe(page, title);
			await expect(editor).toHaveCount(0);
			await card.tap();
			await expect(title).toHaveText('Keep my swiped draft');
			// WebKit scrolls the sheet's one-pixel containment layer when a field is
			// focused; the drag must still reach the sheet.
			await expect(editor).toHaveCSS('transform', 'none');
			await swipe(page, editor.getByRole('textbox', { name: 'Reminder description', exact: true }));
			await expect(editor).toHaveCount(0);
			await card.tap();
			await expect(title).toHaveText('Keep my swiped draft');

			await editor.getByRole('button', { name: 'Inbox', exact: true }).tap();
			const picker = page.getByRole('dialog', { name: 'Select project', exact: true });
			await expect(picker).toBeVisible();
			await expect.poll(scale).toBe(1);
			await expect(canvas).toHaveCSS('transform', 'none');
			await expect(page.locator('.pwa-reminder-sheet-stage')).toHaveCSS('transform', 'none');
			await swipe(page, picker.getByRole('heading', { name: 'Project', exact: true }));
			await expect(editor).toBeVisible();
			await expect(editor).toHaveCSS('transform', 'none');
			await expect(title).toHaveText('Keep my swiped draft');
			await expect(title).toBeFocused();
			const checkButtonDismissal = await trackSheetDismissal(editor, { recedeCanvas: false });
			await editor.getByRole('button', { name: 'Close reminder editor', exact: true }).tap();
			await checkButtonDismissal();
			await expect(page.locator('.pwa-modal-sheet')).toHaveCount(0);
			assert.deepEqual(errors, [], 'Drawer interactions must not throw');
			console.log(`${browserType.name()}: cancelled and completed swipes, native field gestures, retained drafts and picker return passed`);
		} catch (error) {
			if (page) await saveSwipeFailure(page, browserType.name()).catch(diagnosticError => console.error(diagnosticError));
			throw error;
		} finally { await browser.close(); }
	}
} finally {
	await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
