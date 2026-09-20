import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

import { swipe } from './browser-touch-swipe.mjs';
import { recordSwipeDiagnostics, saveSwipeFailure } from './browser-swipe-diagnostics.mjs';

const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
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
			await page.getByRole('button', { name: 'Open settings', exact: true }).tap();
			await expect(settings).toHaveCSS('transform', 'none');
			await swipe(page, settings.getByRole('heading', { name: 'Settings', exact: true }), 16, 400);
			await expect(settings).toHaveCSS('transform', 'none');
			await expect(settings).toBeVisible();
			await swipe(page, settings.getByRole('heading', { name: 'Settings', exact: true }));
			await expect(settings).toHaveCount(0);
			await expect(page.locator('body')).not.toHaveClass(/pwa-sheet-scroll-locked/);

			const card = page.getByRole('group', { name: 'Check this article. Press Enter to edit reminder.', exact: true });
			const cardBox = await card.boundingBox();
			assert.ok(cardBox);
			await card.tap();
			const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
			const editor = page.getByRole('dialog', { name: 'Edit reminder', exact: true });
			await expect(editor).toHaveCSS('transform', 'none');
			await title.fill('Keep my swiped draft');
			await swipe(page, title, 40);
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
			await swipe(page, editor.getByRole('heading', { name: 'Edit reminder', exact: true }));
			await expect(editor).toHaveCount(0);
			await card.tap();
			await expect(title).toHaveText('Keep my swiped draft');

			await editor.getByRole('button', { name: 'Inbox', exact: true }).tap();
			const picker = page.getByRole('dialog', { name: 'Select project', exact: true });
			await expect(picker).toBeVisible();
			await expect(page.locator('.pwa-reminder-sheet-stage')).toHaveCSS('transform', 'none');
			await swipe(page, picker.getByRole('heading', { name: 'Project', exact: true }));
			await expect(editor).toBeVisible();
			await expect(editor).toHaveCSS('transform', 'none');
			await expect(title).toHaveText('Keep my swiped draft');
			await expect(title).toBeFocused();
			await editor.getByRole('button', { name: 'Close reminder editor', exact: true }).tap();
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
