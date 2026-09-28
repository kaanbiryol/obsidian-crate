import { expect } from '@playwright/test';

async function allowsNativeBack(target) {
	return target.evaluate(element => {
		const event = new Event('touchstart', { bubbles: true, cancelable: true });
		Object.defineProperty(event, 'touches', { value: [{ clientX: 5, clientY: 100 }] });
		return element.dispatchEvent(event);
	});
}

export async function checkSettingsNavigation(page) {
	const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
	const shortcut = page.getByRole('dialog', { name: 'Set up iPhone shortcut', exact: true });
	const open = settings.getByRole('button', { name: 'Set up iPhone shortcut', exact: true });
	const main = page.locator('.settings-main');
	await expect(settings.getByRole('region', { name: 'Tabs', exact: true }).getByRole('combobox', { name: 'Default tab' })).toBeVisible();
	for (const section of ['Sync and device', 'About']) {
		await expect(settings.getByRole('region', { name: section, exact: true })).toBeVisible();
		await expect(settings.getByRole('button', { name: section, exact: true })).toHaveCount(0);
	}
	await expect(settings.getByText('Device storage', { exact: true })).toBeVisible();
	await expect(settings.getByText('Web app', { exact: true })).toBeVisible();
	expect(await allowsNativeBack(settings.getByRole('heading', { name: 'Settings', exact: true }))).toBe(false);
	let length;
	for (const method of ['native', 'button', 'escape']) {
		await open.scrollIntoViewIfNeeded();
		await open.click();
		// Native activation can scroll a button into view before the push.
		const scroll = await main.evaluate(el => el.scrollTop);
		await expect(shortcut).toBeVisible();
		await expect(shortcut).toHaveCSS('transform', 'none');
		await expect(shortcut.locator('.settings-shortcut-body')).toBeVisible();
		await expect(page.locator('.settings-page-stack')).toHaveAttribute('inert', '');
		expect(await allowsNativeBack(shortcut.getByRole('heading', { name: 'Set up iPhone shortcut', exact: true }))).toBe(true);
		const currentLength = await page.evaluate(() => history.length);
		if (length !== undefined) expect(currentLength).toBe(length);
		length = currentLength;
		if (method === 'native') await page.goBack();
		else if (method === 'button') await shortcut.getByRole('button', { name: 'Close shortcut setup' }).click();
		else await page.keyboard.press('Escape');
		await expect(shortcut).toHaveCount(0);
		await expect(settings).toBeVisible();
		await expect.poll(() => page.evaluate(() => !!history.state?.cratePushedPage)).toBe(false);
		await expect(open).toBeFocused();
		expect(await main.evaluate(el => el.scrollTop)).toBe(scroll);
	}
	// Forward is owned by this sheet too, even after closing and reopening it.
	await settings.getByRole('button', { name: 'Close settings' }).click();
	await expect(settings).toHaveCount(0);
	await page.goForward();
	await expect(shortcut).toBeVisible();
	await page.goBack();
	await expect(settings).toBeVisible();
}
