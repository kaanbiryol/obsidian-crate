import assert from 'node:assert/strict';
import { chromium, webkit, expect } from '@playwright/test';
import { buildPwaPreviewAssets } from './pwa-preview-assets.mjs';
import { listenPwaPreviewServer } from './pwa-preview-server.mjs';

const assets = await buildPwaPreviewAssets();
const { server } = await listenPwaPreviewServer({ port: 0, assets });
const origin = `http://127.0.0.1:${server.address().port}`;
try {
	for (const browserType of [chromium, webkit]) {
		const browser = await browserType.launch();
		try {
			const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
			await page.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
			const card = page.getByRole('group', { name: 'Check this article. Press Enter to edit reminder.', exact: true });
			await card.waitFor();
			// Observe focus before the card click finishes, not after an async load.
			await page.evaluate(() => {
				window.editorFocusedDuringClick = [];
				document.addEventListener('click', (event) => {
					if (!event.target.closest('.sidebar-reminder-card-wrapper')) return;
					window.editorFocusedDuringClick.push(document.activeElement?.getAttribute('aria-label') === 'Reminder title');
				});
			});
			for (let opening = 0; opening < 2; opening++) {
				await card.tap();
				assert.equal(await page.evaluate(() => window.editorFocusedDuringClick.at(-1)), true,
					`${browserType.name()}: opening ${opening + 1} must focus during the tap`);
				const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
				await expect(title).toHaveText('Check this article');
				await title.fill('Discard this draft');
				await page.getByRole('button', { name: 'Close reminder editor', exact: true }).click();
				await page.getByRole('dialog', { name: 'Edit reminder', exact: true }).waitFor({ state: 'detached' });
			}
			await card.tap();
			await page.getByRole('textbox', { name: 'Reminder title', exact: true }).fill('Updated article');
			await page.getByRole('button', { name: 'Save reminder', exact: true }).click();
			await page.getByRole('dialog', { name: 'Edit reminder', exact: true }).waitFor({ state: 'detached' });
			const updatedCard = page.getByRole('group', { name: 'Updated article. Press Enter to edit reminder.', exact: true });
			await updatedCard.waitFor();
			// Desktop browsers cannot show the software keyboard. Drive its viewport
			// frames explicitly to cover the delay between blur and native dismissal.
			await page.evaluate(() => {
				window.keyboardViewportHeight = 844;
				const viewport = new EventTarget();
				Object.defineProperties(viewport, {
					height: { get: () => window.keyboardViewportHeight },
					width: { value: 390 }, offsetTop: { value: 0 }, offsetLeft: { value: 0 },
					scale: { value: 1 }, pageTop: { value: 0 }, pageLeft: { value: 0 },
				});
				Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true });
			});
			await updatedCard.tap();
			const title = page.getByRole('textbox', { name: 'Reminder title', exact: true });
			await title.fill('Unsaved deletion draft');
			await page.evaluate(() => {
				window.keyboardViewportHeight = 510;
				window.visualViewport.dispatchEvent(new Event('resize'));
			});
			const sheet = page.locator('.pwa-modal-sheet__container--reminder');
			await expect(sheet).toHaveCSS('--pwa-keyboard-inset', '334px');
			await page.getByRole('button', { name: 'Delete reminder', exact: true }).tap();
			const confirmation = page.getByRole('alertdialog', { name: 'Delete reminder?', exact: true });
			await page.waitForTimeout(50);
			await expect(confirmation).toBeHidden();
			await expect(sheet).toHaveCSS('--pwa-keyboard-inset', '334px');
			for (const height of [620, 740]) {
				await page.evaluate(height => {
					window.keyboardViewportHeight = height;
					window.visualViewport.dispatchEvent(new Event('resize'));
				}, height);
				await expect(sheet).toHaveCSS('--pwa-keyboard-inset', `${844 - height}px`);
				await expect(confirmation).toBeHidden();
			}
			await page.evaluate(() => {
				window.keyboardViewportHeight = 844;
				window.visualViewport.dispatchEvent(new Event('resize'));
			});
			await expect(confirmation).toBeVisible();
			await confirmation.getByRole('button', { name: 'Cancel', exact: true }).tap();
			await expect(confirmation).toBeHidden();
			await expect(title).toHaveText('Unsaved deletion draft');
			// The keyboard is already closed, so a second request opens immediately.
			await page.getByRole('button', { name: 'Delete reminder', exact: true }).tap();
			await expect(confirmation).toBeVisible();
			await confirmation.getByRole('button', { name: 'Delete', exact: true }).tap();
			await expect(page.getByRole('dialog', { name: 'Edit reminder', exact: true })).toBeHidden();
			await expect(updatedCard).toBeHidden();
			await expect(page.getByRole('group', { name: 'Unsaved deletion draft. Press Enter to edit reminder.', exact: true })).toBeHidden();
			await page.request.post(`${origin}/preview/reset`);
			console.log(`${browserType.name()}: synchronous focus, discarded drafts, saving and keyboard-aware deletion passed`);
		} finally {
			await browser.close();
		}
	}
} finally {
	await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
