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
			await expect(page.locator('body')).not.toHaveCSS('position', 'fixed');
			await expect(page.locator('.pwa-navigation-viewport')).not.toHaveAttribute('inert');
			await expect(page.locator('.bottom-tab-bar')).not.toHaveAttribute('inert');
			const updatedCard = page.getByRole('group', { name: 'Updated article. Press Enter to edit reminder.', exact: true });
			await updatedCard.waitFor();
			// Desktop browsers cannot show the software keyboard. Simulate its
			// viewport and verify editor geometry and deletion-screen focus recovery.
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
			await expect(page.locator('body')).toHaveCSS('position', 'fixed');
			await expect(page.locator('.pwa-navigation-viewport')).toHaveAttribute('inert', '');
			await expect(page.locator('.bottom-tab-bar')).toHaveAttribute('inert', '');
			await page.evaluate(() => {
				window.keyboardViewportHeight = 510;
				window.visualViewport.dispatchEvent(new Event('resize'));
			});
			const sheet = page.locator('.pwa-modal-sheet__container--reminder');
			await expect(sheet).toHaveCSS('--pwa-keyboard-inset', '334px');
			await expect(sheet).toHaveCSS('transform', 'none');
			const description = page.getByRole('textbox', { name: 'Reminder description', exact: true });
			const beforeDescription = await title.boundingBox();
			// iOS standalone can reduce the layout viewport after the keyboard
			// has opened, even though its visual height has not changed.
			await page.setViewportSize({ width: 390, height: 782 });
			await description.tap();
			await expect(description).toBeFocused();
			// Keep an artificial keyboard scroll range available: gestures must be
			// blocked before scrolling, with no corrective scrollTo calls afterward.
			const keyboardScrollStyle = await page.addStyleTag({ content: '.pwa-test-keyboard-scroll{height:1200px!important;overflow:auto!important}' });
			await page.evaluate(() => {
				document.documentElement.classList.add('pwa-test-keyboard-scroll');
				window.testScrollCorrections = 0;
				window.originalScrollTo = window.scrollTo;
				window.scrollTo = (...args) => {
					window.testScrollCorrections++;
					window.originalScrollTo(...args);
				};
			});
			await page.mouse.move(190, 80);
			await page.mouse.wheel(0, 300);
			if (browserType === chromium) {
				const session = await page.context().newCDPSession(page);
				const titleRect = await title.boundingBox();
				const descriptionRect = await description.boundingBox();
				const points = [
					{ x: 190, y: 200 }, // backdrop
					{ x: titleRect.x + 20, y: titleRect.y + titleRect.height / 2 },
					{ x: descriptionRect.x + 20, y: descriptionRect.y + descriptionRect.height / 2 },
				];
				for (const point of points) for (const direction of [-1, 1]) {
					const beforeSwipe = await title.boundingBox();
					await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
					for (const distance of [15, 30, 45, 60]) {
						await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y + direction * distance }] });
						assert.equal(await page.evaluate(() => window.scrollY), 0, 'The document must stay fixed throughout field and backdrop swipes');
						const duringSwipe = await title.boundingBox();
						assert.ok(Math.abs(duringSwipe.y - beforeSwipe.y) < 1, 'The sheet must stay anchored throughout the swipe');
					}
					await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
				}
				await session.detach();
			}
			await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
			assert.equal(await page.evaluate(() => window.testScrollCorrections), 0, 'Lock must never snap the page back');
			await page.evaluate(() => {
				window.scrollTo = window.originalScrollTo;
				document.documentElement.classList.remove('pwa-test-keyboard-scroll');
			});
			await keyboardScrollStyle.evaluate(element => element.remove());
			// Keyboard padding overflows these fixed wrappers. They must reject
			// programmatic scrolling, including native focus scroll requests.
			const wrapperScroll = await description.evaluate(element => {
				const positions = [];
				for (let parent = element.parentElement; parent; parent = parent.parentElement) {
					if (!parent.matches('#app, .pwa-shadow-root, .pwa-modal-sheet, .pwa-modal-sheet__container, .pwa-modal-sheet__content, .pwa-modal-sheet__scroller, .pwa-reminder-sheet-stage, .pwa-reminder-editor, .modal-form')) continue;
					parent.scrollTop = 100;
					positions.push(parent.scrollTop);
				}
				return positions;
			});
			assert.ok(wrapperScroll.length >= 9 && wrapperScroll.every(top => top === 0), 'Sheet and app wrappers must not scroll on field focus');
			const afterDescription = await title.boundingBox();
			assert.ok(Math.abs(afterDescription.y - beforeDescription.y) < 1, 'Focusing description must not move the sheet');
			await description.fill('A long description that still needs native scrolling.\n'.repeat(20));
			await description.evaluate(element => { element.scrollTop = 0; });
			await description.hover();
			await page.mouse.wheel(0, 180);
			await expect.poll(() => description.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
			assert.equal(await page.evaluate(() => window.scrollY), 0, 'Scrolling description must not move the page');
			await title.tap();
			await page.getByRole('button', { name: 'Delete reminder', exact: true }).tap();
			const confirmation = page.getByRole('alertdialog', { name: 'Delete reminder', exact: true });
			await expect(confirmation).toBeVisible();
			await expect(confirmation).toBeFocused();
			await page.waitForFunction(() => {
				const stage = document.querySelector('.pwa-reminder-sheet-stage');
				return stage && !document.querySelector('.reminder-action-chips')?.inert
					&& Math.abs(new DOMMatrixReadOnly(getComputedStyle(stage).transform).m42) < 0.1;
			});
			await expect(confirmation).toContainText('Unsaved deletion draft');
			await expect(page.locator('.pwa-modal-sheet')).toHaveCount(1);
			// Deletion now has its own sheet screen: focus leaves the editor and
			// stays within the confirmation until cancellation restores the draft.
			await expect(title).toHaveCount(0);
			const firstControl = confirmation.getByRole('button', { name: 'Cancel deletion', exact: true });
			const lastControl = confirmation.getByRole('button', { name: 'Delete reminder', exact: true });
			await lastControl.focus();
			await page.keyboard.press('Tab');
			await expect(firstControl).toBeFocused();
			await page.keyboard.press('Shift+Tab');
			await expect(lastControl).toBeFocused();
			await page.keyboard.press('Escape');
			await expect(confirmation).toHaveCount(0);
			await expect(title).toBeFocused();
			await expect(title).toHaveText('Unsaved deletion draft');
			await expect(description).toHaveValue('A long description that still needs native scrolling.\n'.repeat(20));
			// Confirm deletion after the software keyboard has closed too.
			await page.evaluate(() => {
				window.keyboardViewportHeight = 844;
				window.visualViewport.dispatchEvent(new Event('resize'));
			});
			await expect(page.locator('.pwa-modal-sheet--reminder')).not.toHaveClass(/is-keyboard-open/);
			await page.waitForFunction(() => {
				const stage = document.querySelector('.pwa-reminder-sheet-stage');
				return stage && !document.querySelector('.reminder-action-chips')?.inert
					&& Math.abs(new DOMMatrixReadOnly(getComputedStyle(stage).transform).m42) < 0.1;
			});
			await page.getByRole('button', { name: 'Delete reminder', exact: true }).tap();
			await expect(confirmation).toBeVisible();
			await confirmation.getByRole('button', { name: 'Delete reminder', exact: true }).tap();
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
