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
			// Desktop browsers cannot show the software keyboard. Simulate its
			// viewport and verify confirmation preserves editor focus and geometry.
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
			await expect(sheet).toHaveCSS('transform', 'none');
			const editorBeforeDelete = await title.boundingBox();
			await page.getByRole('button', { name: 'Delete reminder', exact: true }).tap();
			const confirmation = page.getByRole('alertdialog', { name: 'Delete reminder?', exact: true });
			await expect(confirmation).toBeVisible();
			await expect(title).toBeFocused();
			await expect(confirmation.getByRole('button')).toHaveCount(2);
			await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).not.toBeFocused();
			const confirmationBounds = await confirmation.boundingBox();
			assert.ok(confirmationBounds.y >= 0 && confirmationBounds.y + confirmationBounds.height <= 510,
				`${browserType.name()}: confirmation must fit above the software keyboard`);
			const editorAfterDelete = await title.boundingBox();
			assert.ok(Math.abs(editorAfterDelete.y - editorBeforeDelete.y) < 1
				&& Math.abs(editorAfterDelete.height - editorBeforeDelete.height) < 1,
				`${browserType.name()}: opening confirmation must not move the editor`);
			await expect(sheet).toHaveCSS('--pwa-keyboard-inset', '334px');
			await page.keyboard.type('Blocked while confirming');
			await page.keyboard.insertText('Blocked pasted text');
			const blockedNativeEdits = await title.evaluate(element => ['paste', 'cut', 'drop'].map(type => {
				const event = new Event(type, { bubbles: true, cancelable: true });
				return !element.dispatchEvent(event);
			}));
			assert.deepEqual(blockedNativeEdits, [true, true, true],
				`${browserType.name()}: confirmation must block editor clipboard and drop handlers`);
			await expect(title).toHaveText('Unsaved deletion draft');
			await confirmation.getByRole('button', { name: 'Cancel', exact: true }).tap();
			await expect(confirmation).toBeHidden();
			await expect(title).toBeFocused();
			await expect(title).toHaveText('Unsaved deletion draft');
			await page.getByRole('button', { name: 'Delete reminder', exact: true }).tap();
			await expect(confirmation).toBeVisible();
			await page.locator('.pwa-delete-confirmation .base-modal-container').tap({ position: { x: 8, y: 8 } });
			await expect(confirmation).toBeHidden();
			await expect(title).toBeFocused();
			await page.waitForTimeout(500);
			await expect(page.getByRole('dialog', { name: 'Edit reminder', exact: true })).toBeVisible();
			await page.getByRole('button', { name: 'Delete reminder', exact: true }).tap();
			await expect(confirmation).toBeVisible();
			await page.keyboard.press('Tab');
			await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(confirmation.getByRole('button', { name: 'Delete', exact: true })).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(confirmation).toBeHidden();
			await expect(title).toBeFocused();
			await page.waitForTimeout(500);
			await expect(page.getByRole('dialog', { name: 'Edit reminder', exact: true })).toBeVisible();
			// Confirmation also opens immediately when the keyboard is closed.
			await page.evaluate(() => {
				window.keyboardViewportHeight = 844;
				window.visualViewport.dispatchEvent(new Event('resize'));
			});
			await expect(page.locator('.pwa-modal-sheet--reminder')).not.toHaveClass(/is-keyboard-open/);
			await page.getByRole('button', { name: 'Delete reminder', exact: true }).tap();
			await expect(confirmation).toBeVisible();
			await expect(confirmation).toBeFocused();
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
