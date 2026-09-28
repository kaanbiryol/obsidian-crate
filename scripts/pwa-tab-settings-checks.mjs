import { expect } from '@playwright/test';

export async function checkTabSettings(page, name) {
	const gear = page.getByRole('button', { name: 'Open settings', exact: true });
	const sheet = page.getByRole('dialog', { name: 'Settings', exact: true });
	await expect(sheet.getByRole('button', { name: 'Reset tabs', exact: true })).toHaveCount(0);
	// Every destination can occupy a slot; exactly four tabs are always present.
	for (const [index, tab] of ['highlights', 'favorites', 'archive', 'today'].entries()) {
		await sheet.getByRole('combobox', { name: `Tab ${index + 1}`, exact: true }).selectOption(tab);
	}
	await expect(sheet.getByRole('combobox', { name: 'Add tab', exact: true })).toHaveCount(0);
	await expect(sheet.getByRole('button', { name: /^Remove .* tab$/ })).toHaveCount(0);
	await expect(sheet.locator('.settings-tab-list select')).toHaveCount(4);
	const savedTabs = () => page.evaluate(() => JSON.parse(localStorage.getItem('crate-reminders-preferences')).dockTabs);
	await sheet.getByRole('button', { name: 'Reorder Highlights', exact: true }).press('ArrowDown');
	await expect.poll(savedTabs).toEqual(['favorites', 'highlights', 'archive', 'today']);
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
	await expect.poll(savedTabs).toEqual(['archive', 'favorites', 'highlights', 'today']);
	if (name === 'chromium') {
		const session = await page.context().newCDPSession(page);
		try {
			await page.mouse.move(0, 0);
			await expect(sheet.getByRole('button', { name: 'Reorder Reminders', exact: true })).toHaveCSS('touch-action', 'none');
			const start = await sheet.getByRole('button', { name: 'Reorder Reminders', exact: true }).boundingBox();
			const end = await sheet.getByRole('button', { name: 'Reorder Archive', exact: true }).boundingBox();
			const point = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
			await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
			for (let step = 1; step <= 12; step++) {
				await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...point, y: point.y + (end.y - start.y - 8) * step / 12 }] });
				await page.evaluate(() => new Promise(requestAnimationFrame));
			}
			await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
			await expect.poll(savedTabs).toEqual(['today', 'archive', 'favorites', 'highlights']);
			for (let step = 0; step < 3; step++) await sheet.getByRole('button', { name: 'Reorder Reminders', exact: true }).press('ArrowDown');
			await expect.poll(savedTabs).toEqual(['archive', 'favorites', 'highlights', 'today']);
		} finally { await session.detach(); }
	}
	await page.setViewportSize({ width: 320, height: 568 });
	await expect.poll(() => sheet.locator('.settings-tab-list').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: 'test-results/settings/' + name + '-tabs.png' });
	await sheet.getByRole('button', { name: 'Close settings', exact: true }).click();
	await expect(sheet).toHaveCount(0);
	const dockTabs = page.locator('.crate-feature-panel[data-active="true"] .pwa-dock__bar > button');
	await expect.poll(() => dockTabs.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).toEqual(['Archive', 'Favorites', 'Highlights', 'Reminders']);
	for (const label of ['Archive', 'Favorites', 'Highlights', 'Reminders']) {
		await page.locator('.crate-feature-panel[data-active="true"] .pwa-dock').getByRole('button', { name: label, exact: true }).click();
		await expect(page.locator('.crate-feature-panel[data-active="true"] .view-header-title:not([inert] *)')).toHaveText(label);
		await expect(page.locator('.crate-feature-panel[data-active="true"] .pwa-dock [aria-current="page"]')).toHaveAttribute('aria-label', label);
	}
	await page.reload();
	await expect.poll(() => dockTabs.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).toEqual(['Archive', 'Favorites', 'Highlights', 'Reminders']);
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
	await expect.poll(savedTabs).toEqual(['archive', 'favorites', 'highlights', 'today']);
	await page.evaluate(() => { Storage.prototype.setItem = window.__tabStorageSetItem; delete window.__tabStorageSetItem; });

	const activeDock = page.locator('.crate-feature-panel[data-active="true"] .pwa-dock');
	await expect(sheet.locator('.settings-tab-list option[value="today-view"], .settings-tab-list option[value="upcoming"]')).toHaveCount(0);
	// Date views remain launch preferences inside the single Reminders tab.
	for (const [value, label] of [['upcoming', 'Upcoming'], ['today', 'Today']]) {
		await sheet.getByRole('combobox', { name: 'Default tab', exact: true }).selectOption({ label });
		await sheet.getByRole('button', { name: 'Close settings', exact: true }).click();
	await expect(sheet).toHaveCount(0);
		await page.goto(new URL('/notifications', page.url()).href);
		await expect(page.locator('.pwa-schedule-chip[aria-pressed="true"]')).toHaveText(label);
		await expect(activeDock.locator('[aria-current="page"]')).toHaveAttribute('aria-label', 'Reminders');
		await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('crate-reminders-preferences')).defaultScreen)).toBe(value);
		await gear.click();
	}
	// Hiding Reminders exposes its parent in the menu, never its date filters.
	await sheet.getByRole('combobox', { name: 'Tab 4', exact: true }).selectOption('browse');
	await sheet.getByRole('button', { name: 'Close settings', exact: true }).click();
	await expect(sheet).toHaveCount(0);
	await activeDock.getByRole('button', { name: 'Favorites', exact: true }).click();
	await expect.poll(() => dockTabs.nth(3).evaluate(el => !el.closest('[inert]'))).toBe(true);
	await dockTabs.nth(3).press('ArrowDown');
	const hiddenViews = page.getByRole('dialog', { name: 'More views', exact: true });
	await expect(hiddenViews.getByRole('button')).toHaveText(['Inbox', 'Reminders', 'Reading']);
	await hiddenViews.getByRole('button', { name: 'Reminders', exact: true }).click();
	await expect(page.locator('.pwa-schedule-chip[aria-pressed="true"]')).toHaveText('Today');
	await page.getByRole('group', { name: 'Reminder dates' }).getByRole('button', { name: 'Upcoming', exact: true }).click();
	await expect.poll(() => dockTabs.nth(3).evaluate(el => !el.closest('[inert]'))).toBe(true);
	await dockTabs.nth(3).press('ArrowDown');
	await expect(dockTabs.nth(3)).toHaveAttribute('aria-label', 'Reminders');
	await expect(dockTabs.nth(3)).toHaveAttribute('aria-current', 'page');
	await expect(hiddenViews.getByRole('button')).toHaveText(['Inbox', 'Projects', 'Reading']);
	await hiddenViews.getByRole('button', { name: 'Reading', exact: true }).click();
	await gear.click();
	// The switcher belongs to the last slot, even when Reading moves to the third slot.
	await sheet.getByRole('button', { name: 'Reset tabs', exact: true }).click();
	await expect(sheet.getByRole('button', { name: 'Reset tabs', exact: true })).toHaveCount(0);
	await sheet.getByRole('button', { name: 'Reorder Reading', exact: true }).press('ArrowUp');
	await expect.poll(savedTabs).toEqual(['inbox', 'today', 'reading', 'browse']);
	await sheet.getByRole('button', { name: 'Close settings', exact: true }).click();
	await expect(sheet).toHaveCount(0);
	const views = page.getByRole('dialog', { name: 'More views', exact: true });
	const assertSwitcher = async (label = 'Projects') => {
		await expect(activeDock.locator('[data-dock-switcher]')).toHaveAccessibleName(label);
		await expect.poll(() => dockTabs.evaluateAll(buttons => buttons.slice(0, 3).map(button => button.getAttribute('aria-label')))).toEqual(['Inbox', 'Reminders', 'Reading']);
		await expect(dockTabs.nth(0)).not.toHaveAttribute('aria-haspopup');
		await expect(dockTabs.nth(3)).toHaveAttribute('aria-haspopup', 'dialog');
	};
	await assertSwitcher();
	await dockTabs.nth(2).click();
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
	await assertSwitcher('Favorites');
	await expect.poll(savedTabs).toEqual(['inbox', 'today', 'reading', 'favorites']);
	await expect(page.getByRole('searchbox', { name: 'Search reading' })).toBeVisible();
	await page.reload();
	await assertSwitcher('Favorites');
	// Each new selection replaces slot four, across both features.
	for (const [id, label] of [['archive', 'Archive'], ['browse', 'Projects'], ['highlights', 'Highlights']]) {
		await expect.poll(() => dockTabs.nth(3).evaluate(el => !el.closest('[inert]'))).toBe(true);
	await dockTabs.nth(3).press('ArrowDown');
		await views.getByRole('button', { name: label, exact: true }).click();
		await assertSwitcher(label);
		await expect(dockTabs.nth(3)).toHaveAttribute('aria-current', 'page');
		await expect.poll(savedTabs).toEqual(['inbox', 'today', 'reading', id]);
		await dockTabs.nth(2).click();
		await expect(dockTabs.nth(2)).toHaveAttribute('aria-current', 'page');
		await assertSwitcher(label);
	}
	// A failed preference write must leave the slots and current screen intact.
	await page.evaluate(() => {
		window.__tabStorageSetItem = Storage.prototype.setItem;
		Storage.prototype.setItem = function(key, value) {
			if (key === 'crate-reminders-preferences') throw new DOMException('Full', 'QuotaExceededError');
			return window.__tabStorageSetItem.call(this, key, value);
		};
	});
	await expect.poll(() => dockTabs.nth(3).evaluate(el => !el.closest('[inert]'))).toBe(true);
	await dockTabs.nth(3).press('ArrowDown');
	await views.getByRole('button', { name: 'Archive', exact: true }).click();
	await expect(page.getByRole('alert')).toHaveText('Could not save tabs on this device.');
	await assertSwitcher('Highlights');
	await expect(dockTabs.nth(2)).toHaveAttribute('aria-current', 'page');
	await page.evaluate(() => { Storage.prototype.setItem = window.__tabStorageSetItem; delete window.__tabStorageSetItem; });
	await expect.poll(() => dockTabs.nth(3).evaluate(el => !el.closest('[inert]'))).toBe(true);
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
	await expect(sheet.getByRole('button', { name: 'Reset tabs', exact: true })).toHaveCount(0);
	// Replacing Inbox with Highlights moves only the missing screen into More views.
	await sheet.getByRole('combobox', { name: 'Tab 1', exact: true }).selectOption('highlights');
	await sheet.getByRole('button', { name: 'Close settings', exact: true }).click();
	await expect(sheet).toHaveCount(0);
	await activeDock.getByRole('button', { name: 'Highlights', exact: true }).click();
	await expect(page.getByRole('searchbox', { name: 'Search reading' })).toBeVisible();
	await expect.poll(() => dockTabs.nth(3).evaluate(el => !el.closest('[inert]'))).toBe(true);
	await dockTabs.nth(3).press('ArrowDown');
	await expect(views.getByRole('button')).toHaveText(['Inbox', 'Favorites', 'Archive']);
	await views.getByRole('button', { name: 'Inbox', exact: true }).click();
	await expect(page.locator('.crate-feature-panel[data-active="true"] .view-header-title:not([inert] *)')).toHaveText('Inbox');
	await page.reload();
	await expect(dockTabs.nth(3)).toHaveAccessibleName('Inbox');
	await expect.poll(() => dockTabs.nth(3).evaluate(el => !el.closest('[inert]'))).toBe(true);
	await dockTabs.nth(3).press('ArrowDown');
	await expect(views.getByRole('button')).toHaveText(['Reading', 'Favorites', 'Archive']);
	await page.keyboard.press('Escape');
	await gear.click();
	await sheet.getByRole('button', { name: 'Reset tabs', exact: true }).click();
	await sheet.getByRole('button', { name: 'Close settings', exact: true }).click();
	await expect(sheet).toHaveCount(0);
	await expect.poll(() => dockTabs.nth(3).evaluate(el => !el.closest('[inert]'))).toBe(true);
	await dockTabs.nth(3).press('ArrowDown');
	await expect(views.getByRole('button')).toHaveText(['Favorites', 'Archive', 'Highlights']);
	await page.keyboard.press('Escape');
	await activeDock.getByRole('button', { name: 'Inbox', exact: true }).click();
	await gear.click();
}
