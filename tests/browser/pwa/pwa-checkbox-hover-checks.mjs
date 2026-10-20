import assert from 'node:assert/strict';
import { expect } from '@playwright/test';

async function checkboxAppearance(page) {
	return page.locator('.premium-checkbox').evaluateAll(elements => elements.map(element => {
		const visual = getComputedStyle(element.querySelector('.premium-checkbox-visual'));
		return {
			checked: element.getAttribute('aria-checked'),
			border: visual.borderColor,
			background: visual.backgroundColor,
			transform: visual.transform,
		};
	}));
}

export async function checkCheckboxHoverAfterDismissal(browser, origin) {
	for (const colorScheme of ['dark', 'light']) {
		for (const view of ['tab=inbox', 'tab=today', 'project=Work']) {
			const page = await browser.newPage({
				viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme,
			});
			try {
				if (view === 'tab=inbox') {
					const reminders = Array.from({ length: 32 }, (_, index) => ({
						id: `hover-${index}`, content: `Reminder ${index}`, project: 'Inbox',
						completed: false, priority: 4, filePath: 'Reminders/Inbox.md', revision: 'hover-1',
					}));
					await page.route('**/reminders/list?*', route => route.fulfill({ json: { reminders, projects: ['Inbox'] } }));
				}
				await page.goto(`${origin}/notifications?folder=Reminders&${view}`);
				const checkbox = page.locator('.premium-checkbox').nth(view === 'tab=inbox' ? 16 : 0);
				const add = page.locator(view.startsWith('project=') ? '.pwa-project-fab' : '.pwa-dock__add');
				await expect(checkbox).toBeVisible();
				if (view === 'tab=inbox') {
					// Position a real list row under the close button, as on a scrolled
					// inbox. Closing the empty editor must not highlight that checkbox.
					await add.tap();
					const close = page.getByRole('button', { name: 'Close reminder editor', exact: true });
					await close.tap({ trial: true });
					const bounds = await close.boundingBox();
					await close.tap();
					await expect(page.locator('.pwa-modal-sheet')).toHaveCount(0);
					await checkbox.evaluate((element, y) => {
						const rect = element.getBoundingClientRect();
						element.closest('.reminders-view-scroll').scrollTop += rect.y + rect.height / 2 - y;
					}, bounds.y + bounds.height / 2);
				}
				const before = await checkboxAppearance(page);
				for (const dismissal of ['close', 'backdrop']) {
					const bounds = await checkbox.boundingBox();
					await add.tap();
					await expect(page.getByRole('dialog', { name: 'New reminder', exact: true })).toBeVisible();
					await expect(page.locator('.pwa-modal-sheet__container')).toHaveCSS('transform', 'none');
					if (dismissal === 'close') {
						const close = page.getByRole('button', { name: 'Close reminder editor', exact: true });
						await close.tap({ trial: true });
						if (view === 'tab=inbox') {
							const closeBounds = await close.boundingBox();
							const x = closeBounds.x + closeBounds.width / 2, y = closeBounds.y + closeBounds.height / 2;
							assert.ok(x > bounds.x && x < bounds.x + bounds.width && y > bounds.y && y < bounds.y + bounds.height,
								`The close button must sit over a checkbox for the regression: ${JSON.stringify({ closeBounds, bounds })}`);
						}
						await close.tap();
					} else {
						// WebKit transfers hover to the checkbox under the removed backdrop.
						// Keep the pointer here after dismissal to catch the lingering highlight.
						// On the scrolled inbox use a higher row, above the sheet.
						const backdropBounds = view === 'tab=inbox' ? await page.locator('.premium-checkbox').nth(12).boundingBox() : bounds;
						const point = { x: backdropBounds.x + backdropBounds.width / 2, y: backdropBounds.y + backdropBounds.height / 2 };
						assert.ok(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)
							?.classList.contains('pwa-modal-sheet__backdrop'), point));
						await page.touchscreen.tap(point.x, point.y);
					}
					await expect(page.locator('.pwa-modal-sheet')).toHaveCount(0);
					await expect.poll(() => checkboxAppearance(page), {
						message: `${colorScheme} ${view}: ${dismissal} must preserve checkbox appearance and completion`,
					}).toEqual(before);
				}
			} finally {
				await page.close();
			}
		}
		const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme });
		try {
			await desktop.goto(`${origin}/notifications?folder=Reminders&tab=inbox`);
			const checkbox = desktop.locator('.premium-checkbox').first();
			await expect(checkbox).toBeVisible();
			const before = await checkboxAppearance(desktop);
			await checkbox.hover();
			await expect(checkbox.locator('.premium-checkbox-visual')).toHaveCSS('transform', 'matrix(1.05, 0, 0, 1.05, 0, 0)');
			await desktop.mouse.move(0, 0);
			await expect.poll(() => checkboxAppearance(desktop)).toEqual(before);
		} finally {
			await desktop.close();
		}
	}
	console.log(`${browser.browserType().name()}: dismissed empty editors preserve touch checkboxes across views and themes; mouse hover still works`);
}
