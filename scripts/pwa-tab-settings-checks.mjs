import { expect } from '@playwright/test';

export async function checkTabSettings(page, name) {
	const gear = page.getByRole('button', { name: 'Open settings', exact: true });
	const sheet = page.getByRole('dialog', { name: 'Settings', exact: true });
	// Every destination can occupy a slot; exactly four tabs are always present.
	for (const [index, tab] of ['highlights', 'favorites', 'archive', 'upcoming'].entries()) {
		await sheet.getByRole('combobox', { name: `Tab ${index + 1}`, exact: true }).selectOption(tab);
	}
	await expect(sheet.getByRole('combobox', { name: 'Add tab', exact: true })).toHaveCount(0);
	await expect(sheet.getByRole('button', { name: /^Remove .* tab$/ })).toHaveCount(0);
	await expect(sheet.locator('.settings-tab-list select')).toHaveCount(4);
	const savedTabs = () => page.evaluate(() => JSON.parse(localStorage.getItem('crate-reminders-preferences')).dockTabs);
	await sheet.getByRole('button', { name: 'Reorder Highlights', exact: true }).press('ArrowDown');
	await expect.poll(savedTabs).toEqual(['favorites', 'highlights', 'archive', 'upcoming']);
	// Drag only the handle, leaving the row and its picker scrollable.
	const handle = sheet.getByRole('button', { name: 'Reorder Archive', exact: true });
	await handle.scrollIntoViewIfNeeded();
	const from = await handle.boundingBox();
	const to = await sheet.getByRole('button', { name: 'Reorder Favorites', exact: true }).boundingBox();
	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	for (let step = 1; step <= 12; step++) {
		await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + (to.y - from.y - 8) * step / 12);
		await page.evaluate(() => new Promise(requestAnimationFrame));
	}
	await page.mouse.up();
	await expect.poll(savedTabs).toEqual(['archive', 'favorites', 'highlights', 'upcoming']);
	if (name === 'chromium') {
		const session = await page.context().newCDPSession(page);
		try {
			await page.mouse.move(0, 0);
			await expect(sheet.getByRole('button', { name: 'Reorder Upcoming', exact: true })).toHaveCSS('touch-action', 'none');
			const start = await sheet.getByRole('button', { name: 'Reorder Upcoming', exact: true }).boundingBox();
			const end = await sheet.getByRole('button', { name: 'Reorder Archive', exact: true }).boundingBox();
			const point = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
			await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
			for (let step = 1; step <= 12; step++) {
				await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: point.y + (end.y - start.y - 8) * step / 12 }] });
				await page.evaluate(() => new Promise(requestAnimationFrame));
			}
			await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
			await expect.poll(savedTabs).toEqual(['upcoming', 'archive', 'favorites', 'highlights']);
			for (let step = 0; step < 3; step++) await sheet.getByRole('button', { name: 'Reorder Upcoming', exact: true }).press('ArrowDown');
			await expect.poll(savedTabs).toEqual(['archive', 'favorites', 'highlights', 'upcoming']);
		} finally { await session.detach(); }
	}
	await page.setViewportSize({ width: 320, height: 568 });
	await expect.poll(() => sheet.locator('.settings-tab-list').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: 'test-results/settings/' + name + '-tabs.png' });
	await sheet.getByRole('button', { name: 'Close settings', exact: true }).click();
	const dockTabs = page.locator('.crate-feature-panel[data-active="true"] .pwa-dock__bar > button');
	await expect.poll(() => dockTabs.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).toEqual(['Archive', 'Favorites', 'Highlights', 'Upcoming']);
	for (const label of ['Archive', 'Favorites', 'Highlights', 'Upcoming']) {
		await page.locator('.crate-feature-panel[data-active="true"] .pwa-dock').getByRole('button', { name: label, exact: true }).click();
		await expect(page.locator('.crate-feature-panel[data-active="true"] .view-header-title:not([inert] *)')).toHaveText(label === 'Upcoming' ? 'Reminders' : label);
		await expect(page.locator('.crate-feature-panel[data-active="true"] .pwa-dock [aria-current="page"]')).toHaveAttribute('aria-label', label);
	}
	await page.reload();
	await expect.poll(() => dockTabs.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).toEqual(['Archive', 'Favorites', 'Highlights', 'Upcoming']);
	await gear.click();
	await page.evaluate(() => {
		window.__tabStorageSetItem = Storage.prototype.setItem;
		Storage.prototype.setItem = function(key, value) {
			if (key === 'crate-reminders-preferences') throw new DOMException('Full', 'QuotaExceededError');
			return window.__tabStorageSetItem.call(this, key, value);
		};
	});
	await sheet.getByRole('combobox', { name: 'Tab 1', exact: true }).selectOption('inbox');
	await expect(sheet.getByRole('alert')).toHaveText('Could not save settings on this device.');
	await expect(sheet.getByRole('combobox', { name: 'Tab 1', exact: true })).toHaveValue('archive');
	await expect.poll(savedTabs).toEqual(['archive', 'favorites', 'highlights', 'upcoming']);
	await page.evaluate(() => { Storage.prototype.setItem = window.__tabStorageSetItem; delete window.__tabStorageSetItem; });

	await sheet.getByRole('combobox', { name: 'Tab 1', exact: true }).selectOption('today-view');
	await sheet.getByRole('button', { name: 'Close settings', exact: true }).click();
	const activeDock = page.locator('.crate-feature-panel[data-active="true"] .pwa-dock');
	await activeDock.getByRole('button', { name: 'Favorites', exact: true }).click();
	await activeDock.getByRole('button', { name: 'Today', exact: true }).click();
	await expect(page.locator('.pwa-schedule-chip[aria-pressed="true"]')).toHaveText('Today');
	await expect(activeDock.locator('[aria-current="page"]')).toHaveAttribute('aria-label', 'Today');
	await activeDock.getByRole('button', { name: 'Upcoming', exact: true }).click();
	await expect(page.locator('.pwa-schedule-chip[aria-pressed="true"]')).toHaveText('Upcoming');
	await activeDock.getByRole('button', { name: 'Today', exact: true }).click();
	await expect(page.locator('.pwa-schedule-chip[aria-pressed="true"]')).toHaveText('Today');
	await page.reload();
	await expect(activeDock.getByRole('button', { name: 'Today', exact: true })).toBeVisible();
	await gear.click();
	// The switcher belongs to the last slot, even when Reading moves first.
	await sheet.getByRole('button', { name: 'Reset tabs', exact: true }).click();
	for (let step = 0; step < 3; step++) await sheet.getByRole('button', { name: 'Reorder Reading', exact: true }).press('ArrowUp');
	await expect.poll(savedTabs).toEqual(['reading', 'inbox', 'today', 'browse']);
	await sheet.getByRole('button', { name: 'Close settings', exact: true }).click();
	const views = page.getByRole('dialog', { name: 'Reading views', exact: true });
	const assertSwitcher = async () => {
		await expect(activeDock.locator('[data-dock-switcher]')).toHaveAccessibleName('Projects');
		await expect(dockTabs.nth(0)).not.toHaveAttribute('aria-haspopup');
		await expect(dockTabs.nth(3)).toHaveAttribute('aria-haspopup', 'dialog');
	};
	await assertSwitcher();
	await dockTabs.nth(0).click();
	await expect(page.locator('.crate-feature-panel[data-active="true"]')).toHaveAttribute('data-crate-section', 'reading');
	await assertSwitcher();
	await dockTabs.nth(3).click();
	await expect(page.locator('.crate-feature-panel[data-active="true"] .view-header-title:not([inert] *)')).toHaveText('Projects');
	const last = await dockTabs.nth(3).boundingBox();
	await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2);
	await page.mouse.down();
	await page.waitForTimeout(480);
	await page.mouse.up();
	await expect(views).toBeVisible();
	await views.getByRole('button', { name: 'Favorites', exact: true }).click();
	await expect(views).toHaveCount(0);
	await assertSwitcher();
	await page.reload();
	await assertSwitcher();
	await dockTabs.nth(3).press('ArrowDown');
	await expect(views).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(dockTabs.nth(3)).toBeFocused();
	for (const colorScheme of ['light', 'dark']) {
		await page.emulateMedia({ colorScheme });
		await page.screenshot({ path: 'test-results/settings/' + name + '-switcher-' + colorScheme + '.png' });
	}
	await gear.click();
	await sheet.getByRole('button', { name: 'Reset tabs', exact: true }).click();
	await sheet.getByRole('button', { name: 'Close settings', exact: true }).click();
	await page.locator('.crate-feature-panel[data-active="true"] .pwa-dock').getByRole('button', { name: 'Inbox', exact: true }).click();
	await gear.click();
}
